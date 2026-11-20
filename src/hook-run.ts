/**
 * Runs a session's hooks (docs/MAC.md H1 to H3) once its pipeline has finished. Each hook is started
 * with spawn and an argument array, never a shell, in its own process group so a timeout stops
 * everything it started (SIGTERM, then SIGKILL once the grace is over, even when the hook itself has
 * gone: what it started may ignore SIGTERM), with an environment that leaves out polycap's secrets
 * and a surrounding Claude session's markers (hooks.ts). Its stdout and stderr go to
 * <session>/hooks/<name>.log (capped at 1 MB), the session's JSON summary to its stdin, and its
 * outcome to hook-runs.json as it starts and as it ends, with the tool calls Claude Code says it
 * denied in the note. Once per session per hook: a recorded run is not repeated unless forced, and a
 * run left "running" by a polycap that stopped is marked interrupted, never restarted behind the
 * user's back. A lock file in the session folder keeps two polycap processes from running the same
 * session's hooks at once.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { constants, createWriteStream } from 'node:fs';
import { access, chmod, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import type { Config } from './config.js';
import { UserError } from './errors.js';
import { privateDir, writeJsonAtomic } from './fsx.js';
import { expandTilde, hookEnvironment, hookInput, hookLog, hookMatch, hookRunsPath, hookRunsSchema, hookTitle, isFinal, loadHooks, MAX_TIMEOUT_MINUTES, readHookRuns, substitute, type Hook, type HookRun, type HookRuns } from './hooks.js';
import { isPending, loadSession, type SessionManifest } from './session.js';

/** The log keeps the first megabyte of what a hook prints; the rest is counted, not kept. */
export const LOG_CAP = 1024 * 1024;
/** After its timeout, a hook's group gets this long between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 5000;
/**
 * When polycap itself is stopped by a signal, the hook's group gets this long between SIGTERM and
 * SIGKILL (a second signal sends the SIGKILL at once): under the Mac app's 5 s between its SIGTERM
 * and SIGKILL of polycap (ProcessRunner.swift), so the run is recorded before polycap is killed.
 */
const SIGNAL_GRACE_MS = 3000;
/** After the hook exits, how long a process it left behind may keep its output open before polycap stops reading. */
const CLOSE_GRACE_MS = 2000;
/** A run still "running" this long after its timeout cannot be the hook any more, whatever has its pid now. */
const ORPHAN_GRACE_MS = 5 * 60_000;
/** A lock older than the longest hook and this margin belongs to a pid that has been reused. */
const LOCK_MAX_AGE_MS = MAX_TIMEOUT_MINUTES * 60_000 + 10 * 60_000;

export interface RunHooksOptions {
  /** Run hooks whose outcome is already recorded again. */
  force?: boolean;
  /** Only this hook; named, it runs whatever its filter says (a pending step still stops it). */
  only?: string;
  /** The hooks to use instead of reading the hooks file. */
  hooks?: Hook[];
  log?: (line: string) => void;
  /** Tests: between SIGTERM and SIGKILL when a hook is stopped. */
  killGraceMs?: number;
}

export interface HooksOutcome {
  id: string; dir: string;
  /** hook-runs.json after this run. */
  runs: HookRuns['runs'];
  /** The hooks started this time, in order. */
  ran: string[];
  /** Each configured hook not started this time, and why. */
  notRun: Record<string, string>;
  /** Another polycap holds this session's hooks lock; nothing was run or recorded. */
  busy?: string;
}

/** polycap was stopped by a signal while a hook ran; the hook was stopped and recorded too. */
export class HooksStopped extends UserError {
  constructor(readonly signal: NodeJS.Signals, hook: string) { super(`stopped by ${signal}; hook ${hook} was stopped too and recorded as failed`, ({ SIGHUP: 129, SIGINT: 130 } as Partial<Record<NodeJS.Signals, number>>)[signal] ?? 143); }
}

const now = () => new Date().toISOString();

/** True while a process with this pid exists (EPERM: it exists, as someone else's). */
export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

const lockPath = (dir: string) => join(dir, 'hooks', '.lock');
const lockText = () => JSON.stringify({ pid: process.pid, at: now() });
const readLock = (text: string): { pid: number; at: string } | undefined => {
  try { const v = JSON.parse(text) as { pid?: unknown; at?: unknown }; return Number.isInteger(v.pid) && typeof v.at === 'string' ? { pid: v.pid as number, at: v.at } : undefined; } catch { return undefined; }
};

/**
 * The session's hooks lock: created exclusively, holding this pid. A lock whose pid is gone (a polycap
 * killed outright) is taken over, but only while it still holds what was read, so two processes that
 * both find it stale do not both take it.
 */
async function acquireLock(dir: string): Promise<{ release: () => Promise<void>; refresh: () => Promise<void> } | { busy: string }> {
  const path = lockPath(dir);
  await privateDir(join(dir, 'hooks'));
  for (let attempt = 0; attempt < 3; attempt++) {
    let mine = lockText();
    try {
      await writeFile(path, mine, { flag: 'wx', mode: 0o600 });
      return {
        refresh: async () => { const next = lockText(); if (await readFile(path, 'utf8').catch(() => undefined) === mine) { await writeFile(path, next, { mode: 0o600 }); mine = next; } },
        release: async () => { if (await readFile(path, 'utf8').catch(() => undefined) === mine) await unlink(path).catch(() => undefined); },
      };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const text = await readFile(path, 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    const holder = readLock(text);
    if (holder && alive(holder.pid) && Date.now() - Date.parse(holder.at) < LOCK_MAX_AGE_MS) {
      return { busy: `polycap (pid ${holder.pid}) has been running this session's hooks since ${holder.at}; if no polycap is running, remove ${path}` };
    }
    // Being written this instant by another process: theirs.
    if (!holder && Date.now() - (await stat(path).catch(() => ({ mtimeMs: 0 }))).mtimeMs < 10_000) return { busy: `another polycap is taking this session's hooks lock (${path})` };
    if (await readFile(path, 'utf8').catch(() => undefined) === text) await unlink(path).catch(() => undefined);
  }
  return { busy: `could not take this session's hooks lock (${path})` };
}

/** Writes one hook's run into hook-runs.json, atomically and 0600, keeping the others as they are. */
async function recordRun(dir: string, name: string, run: HookRun): Promise<HookRuns> {
  const current = await readHookRuns(dir);
  const next = hookRunsSchema.parse({ version: 1, runs: { ...current.runs, [name]: run } });
  await writeJsonAtomic(hookRunsPath(dir), next);
  return next;
}

/**
 * A run found "running" while this process holds the lock was started by a polycap that has stopped,
 * so its outcome can no longer be recorded. Interrupted when its pid is gone or it is past its timeout;
 * still running (and so not started again, even when forced) while its pid lives within its time.
 */
function settleOrphan(run: HookRun, hook: Hook | undefined): HookRun | 'alive' {
  const limit = (hook?.timeoutMinutes ?? MAX_TIMEOUT_MINUTES) * 60_000 + ORPHAN_GRACE_MS;
  const living = run.pid !== undefined && alive(run.pid);
  if (living && Date.now() - Date.parse(run.startedAt) < limit) return 'alive';
  const { pid: _pid, ...rest } = run;
  return { ...rest, status: 'failed', finishedAt: now(), note: living ? `interrupted: the polycap that ran it stopped, and pid ${run.pid} outlived the hook's timeout` : 'interrupted' };
}

/**
 * Where a hook's program would be found, as spawn looks for it: a path (after `~`) relative to the
 * hook's folder, else each folder of its PATH. For `polycap doctor`; spawn itself decides at run time.
 */
export async function findProgram(program: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string | undefined> {
  const name = expandTilde(program);
  const runnable = async (path: string) => (await stat(path).catch(() => undefined))?.isFile() && await access(path, constants.X_OK).then(() => true, () => false);
  if (name.includes('/')) { const path = isAbsolute(name) ? name : resolve(cwd, name); return await runnable(path) ? path : undefined; }
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) if (await runnable(join(dir, name))) return join(dir, name);
  return undefined;
}

/** What `pick` finds in the whole of stdout as one JSON document, else in its last JSON line that has it (stream-json). */
function fromClaudeJson<T>(stdout: string, pick: (value: unknown) => T | undefined): T | undefined {
  try { const whole = pick(JSON.parse(stdout)); if (whole !== undefined) return whole; } catch { /* not one JSON document */ }
  for (const line of stdout.trim().split('\n').reverse()) {
    if (!line.trim().startsWith('{')) continue;
    try { const found = pick(JSON.parse(line)); if (found !== undefined) return found; } catch { /* not JSON */ }
  }
  return undefined;
}

/** Claude Code's `--output-format json` prints one object with session_id; stream-json ends with a line that has it. */
export const agentSessionId = (stdout: string): string | undefined => fromClaudeJson(stdout, value => {
  const id = value && typeof value === 'object' ? (value as { session_id?: unknown }).session_id : undefined;
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : undefined;
});

/**
 * The tool calls Claude Code denied, from its result's permission_denials: how many, and the tools'
 * names, each once. A headless run under --permission-mode dontAsk denies whatever --allowedTools
 * does not list and still exits 0, so this is how a routine that could not write its notes is told
 * from one that did. Undefined when the output has no such list.
 */
export const permissionDenials = (stdout: string): { count: number; tools: string[] } | undefined => fromClaudeJson(stdout, value => {
  const list = value && typeof value === 'object' ? (value as { permission_denials?: unknown }).permission_denials : undefined;
  if (!Array.isArray(list)) return undefined;
  const names = list.map(d => d && typeof d === 'object' ? (d as { tool_name?: unknown }).tool_name : undefined)
    .filter((name): name is string => typeof name === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(name));
  return { count: list.length, tools: [...new Set(names)] };
});

/** The note for a run with denials: "claude denied 2 tool calls (Write, Bash)". */
export function denialNote(denials: { count: number; tools: readonly string[] } | undefined): string | undefined {
  if (!denials?.count) return undefined;
  const tools = denials.tools.length > 8 ? [...denials.tools.slice(0, 8), `${denials.tools.length - 8} more`] : denials.tools;
  return `claude denied ${denials.count} tool ${denials.count === 1 ? 'call' : 'calls'}${tools.length ? ` (${tools.join(', ')})` : ''}`;
}

const killGroup = (child: ChildProcess, signal: NodeJS.Signals) => {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already gone */ } }
};

/** Whether any process is left in the group the hook led (EPERM: one exists, as someone else's). */
const groupAlive = (pgid: number) => {
  try { process.kill(-pgid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** polycap's signal, and how to stop the hook running now: SIGTERM, then SIGKILL after graceMs (0: at once). */
interface Stopper { signal?: NodeJS.Signals; stop?: (graceMs: number) => void }

/** Starts one hook and waits for it, recording "running" with its pid, then its outcome. */
async function runHook(dir: string, manifest: SessionManifest, hook: Hook, stopper: Stopper, killGraceMs: number): Promise<HookRun> {
  const startedAt = now();
  const log = hookLog(hook.name);
  const fail = async (note: string) => recordRun(dir, hook.name, { status: 'failed', startedAt, finishedAt: now(), note, log }).then(r => r.runs[hook.name]);
  const argv = substitute(hook.run, { id: manifest.id, dir, title: hookTitle(manifest) });
  argv[0] = expandTilde(argv[0]);
  const cwd = expandTilde(hook.cwd ?? '~');
  await privateDir(join(dir, 'hooks'));
  const logPath = join(dir, log);
  const out = createWriteStream(logPath, { flags: 'w', mode: 0o600 });
  await chmod(logPath, 0o600).catch(() => undefined);
  const closeLog = () => new Promise<void>(resolve => out.end(resolve));
  out.write(`# polycap hook ${hook.name} for ${manifest.id}, ${startedAt}, in ${cwd}\n`);
  if (!(await stat(cwd).catch(() => undefined))?.isDirectory()) { await closeLog(); return fail(`cwd ${hook.cwd ?? '~'} is not a folder`); }

  const env = hookEnvironment(process.env, hook, { POLYCAP_SESSION_ID: manifest.id, POLYCAP_SESSION_DIR: dir, POLYCAP_HOOK: hook.name });
  const input = `${JSON.stringify(await hookInput(hook, manifest, dir))}\n`;
  const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  // Listened for at once: a hook can be over before the first await below returns.
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const closed = new Promise<boolean>(resolve => child.once('close', () => resolve(true)));
  let logged = 0, dropped = 0;
  const stdout: Buffer[] = []; let stdoutBytes = 0;
  const keep = (chunk: Buffer) => {
    const room = Math.max(0, LOG_CAP - logged);
    if (room) { const part = chunk.subarray(0, room); out.write(part); logged += part.length; }
    dropped += Math.max(0, chunk.length - room);
  };
  child.stdout!.on('data', (chunk: Buffer) => { keep(chunk); if (stdoutBytes < LOG_CAP) { stdout.push(chunk.subarray(0, LOG_CAP - stdoutBytes)); stdoutBytes += Math.min(chunk.length, LOG_CAP - stdoutBytes); } });
  child.stderr!.on('data', keep);
  // A hook that does not read its stdin closes it early; that is its business.
  child.stdin!.on('error', () => undefined);
  const startError = await new Promise<NodeJS.ErrnoException | undefined>(resolve => { child.once('spawn', () => resolve(undefined)); child.once('error', resolve); });
  if (startError || child.pid === undefined) {
    await closeLog();
    const why = startError?.code === 'ENOENT' ? 'not found (check the hook\'s PATH, or give the full path)' : startError?.code === 'EACCES' ? 'not executable' : startError?.message ?? 'no pid';
    return fail(`${hook.run[0]} could not be started: ${why}`);
  }
  // Stopping the group: SIGTERM at once, SIGKILL when the grace is over. Until 2026-11-05 the SIGKILL
  // was cancelled when the hook itself exited on the SIGTERM, so a process it had started that ignored
  // SIGTERM kept running after the run was recorded. A shorter grace brings the SIGKILL forward.
  const pgid = child.pid;
  let stopping = false, killed = false, killAt = Number.POSITIVE_INFINITY, killTimer: NodeJS.Timeout | undefined;
  const kill = () => { killed = true; clearTimeout(killTimer); killGroup(child, 'SIGKILL'); };
  const stop = (graceMs: number) => {
    if (!stopping) { stopping = true; killGroup(child, 'SIGTERM'); }
    if (Date.now() + graceMs >= killAt) return;
    killAt = Date.now() + graceMs; clearTimeout(killTimer);
    if (graceMs <= 0) kill(); else killTimer = setTimeout(kill, graceMs);
  };
  stopper.stop = stop;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stop(killGraceMs); }, hook.timeoutMinutes * 60_000);
  // A signal that came while the hook was being started.
  if (stopper.signal) stop(SIGNAL_GRACE_MS);
  child.stdin!.end(input);
  await recordRun(dir, hook.name, { status: 'running', startedAt, pid: child.pid, log });
  const exit = await exited;
  clearTimeout(timer);
  // Its output is complete once the pipes close; a process it left behind holding them is not waited for.
  let grace: NodeJS.Timeout | undefined;
  const complete = await Promise.race([closed, new Promise<boolean>(resolve => { grace = setTimeout(() => resolve(false), CLOSE_GRACE_MS); })]);
  clearTimeout(grace);
  // Once stopping, the group is not left to itself when the hook goes: it is waited for until it is
  // empty or the grace is over, and then SIGKILLed, before the run is recorded.
  while (stopping && !killed && groupAlive(pgid)) await new Promise(resolve => setTimeout(resolve, 100));
  clearTimeout(killTimer);
  stopper.stop = undefined;
  if (!complete) { child.stdout!.destroy(); child.stderr!.destroy(); }
  if (dropped) out.write(`\n# polycap: log capped at ${LOG_CAP} bytes; ${dropped} more bytes not kept\n`);
  if (!complete) out.write('\n# polycap: a process the hook started kept its output open after it exited; not read further\n');
  await closeLog();

  const printed = Buffer.concat(stdout).toString('utf8');
  const sessionId = agentSessionId(printed);
  const notes = [
    stopper.signal ? `stopped: polycap got ${stopper.signal}` : '',
    timedOut ? `stopped after ${hook.timeoutMinutes} min` : '',
    // Still done: the agent finished, but without what it was refused (the app's call page shows the note).
    denialNote(permissionDenials(printed)) ?? '',
    dropped ? `log capped at 1 MB (${dropped} bytes not kept)` : '',
  ].filter(Boolean);
  // A run stopped because polycap was stopped failed, whatever else happened; it is never taken for the hook's own timeout.
  const status: HookRun['status'] = stopper.signal ? 'failed' : timedOut ? 'timeout' : exit.code === 0 ? 'done' : 'failed';
  const run: HookRun = {
    status, startedAt, finishedAt: now(),
    ...(exit.code !== null ? { exitCode: exit.code } : {}), ...(exit.signal ? { signal: exit.signal } : {}),
    // hook-runs.json takes a note of at most 1000 characters (hooks.ts).
    ...(sessionId ? { agentSessionId: sessionId } : {}), ...(notes.length ? { note: notes.join('; ').slice(0, 1000) } : {}), log,
  };
  return (await recordRun(dir, hook.name, run)).runs[hook.name];
}

/**
 * Runs the session's hooks that match it, in the order configured, and records each. Returns what
 * ran and why the others did not; `busy` when another polycap is running them. Nothing is retried:
 * a failure is recorded and the next hook still runs.
 */
export async function runSessionHooks(config: Config, dir: string, options: RunHooksOptions = {}): Promise<HooksOutcome> {
  const log = options.log ?? (() => {});
  const all = options.hooks ?? (await loadHooks(config.hooksFile)).hooks;
  const manifest = await loadSession(dir);
  if (options.only && !all.some(h => h.name === options.only)) {
    throw new UserError(`no hook named ${options.only} in ${config.hooksFile}${all.length ? ` (there are ${all.map(h => h.name).join(', ')})` : ''}`);
  }
  const hooks = options.only ? all.filter(h => h.name === options.only) : all;
  const outcome: HooksOutcome = { id: manifest.id, dir, runs: (await readHookRuns(dir)).runs, ran: [], notRun: {} };
  const pending = isPending(manifest);
  // Named on the command line, a hook runs for any finished session, whatever its filter says.
  const decided = hooks.map(hook => ({ hook, match: options.only && !pending ? { run: true as const } : hookMatch(hook, manifest) }));
  for (const { hook, match } of decided) {
    if (!match.run && match.skipped === undefined) outcome.notRun[hook.name] = pending ? 'steps are still pending' : `for ${hook.when.mode === 'call' ? 'calls' : 'walkthroughs'} only`;
  }
  const relevant = decided.filter(d => d.match.run || d.match.skipped !== undefined);
  if (!relevant.length) return outcome;

  const lock = await acquireLock(dir);
  if ('busy' in lock) { log(`${manifest.id} hooks: ${lock.busy}`); return { ...outcome, busy: lock.busy }; }
  const stopper: Stopper = {};
  // The first signal stops the running hook with a short grace; a second one kills its group at once.
  // Either way polycap waits to record the run, and then stops (HooksStopped).
  const onSignal = (signal: NodeJS.Signals) => {
    const again = stopper.signal !== undefined;
    stopper.signal ??= signal;
    stopper.stop?.(again ? 0 : SIGNAL_GRACE_MS);
  };
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, onSignal);
  let stoppedIn: string | undefined;
  try {
    // Runs left "running" by a polycap that stopped: settled before anything is decided.
    for (const [name, run] of Object.entries((await readHookRuns(dir)).runs)) {
      if (run.status !== 'running') continue;
      const settled = settleOrphan(run, all.find(h => h.name === name));
      if (settled !== 'alive') { await recordRun(dir, name, settled); log(`${manifest.id} hook ${name}: ${settled.note}`); }
    }
    for (const { hook, match } of relevant) {
      if (stopper.signal) { outcome.notRun[hook.name] = `polycap got ${stopper.signal}`; continue; }
      const existing = (await readHookRuns(dir)).runs[hook.name];
      if (existing?.status === 'running') { outcome.notRun[hook.name] = `still running as pid ${existing.pid}, started ${existing.startedAt} by a polycap that has stopped`; continue; }
      // A skip is decided afresh each time, but never written over a run that happened.
      if (!match.run && isFinal(existing)) { outcome.notRun[hook.name] = match.skipped!; continue; }
      if (isFinal(existing) && !options.force) { outcome.notRun[hook.name] = `already ${existing!.status} (${existing!.finishedAt ?? existing!.startedAt}); --force runs it again`; continue; }
      if (!match.run) {
        const at = now();
        await recordRun(dir, hook.name, { status: 'skipped', startedAt: at, finishedAt: at, note: match.skipped });
        outcome.notRun[hook.name] = match.skipped!;
        log(`${manifest.id} hook ${hook.name}: skipped (${match.skipped})`);
        continue;
      }
      await lock.refresh();
      log(`${manifest.id} hook ${hook.name}: running`);
      const run = await runHook(dir, manifest, hook, stopper, options.killGraceMs ?? KILL_GRACE_MS);
      outcome.ran.push(hook.name);
      log(`${manifest.id} hook ${hook.name}: ${run.status}${run.exitCode !== undefined ? ` (exit ${run.exitCode})` : ''}${run.note ? `, ${run.note}` : ''}`);
      if (stopper.signal) stoppedIn = hook.name;
    }
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
    await lock.release();
  }
  outcome.runs = (await readHookRuns(dir)).runs;
  if (stopper.signal) throw new HooksStopped(stopper.signal, stoppedIn ?? '(none started)');
  return outcome;
}
