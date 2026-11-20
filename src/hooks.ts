/**
 * Routine hooks (docs/MAC.md H1 to H3, H7): what the user wants run when a bundle is ready, and the
 * record of what ran. This module owns the words: hooks.json (`~/.config/polycap/hooks.json` or
 * POLYCAP_HOOKS, version 1, strict), which hooks a session matches, the argument substitution, the
 * JSON the hook reads on stdin, and hook-runs.json beside the bundle. Running them, with the lock and
 * the timeout, is hook-run.ts. A hook is the user's own command: Polydance never holds an agent login.
 */
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { callTitle } from './call.js';
import { UserError } from './errors.js';
import { exists, readJson } from './fsx.js';
import { isPending, sessionPaths, STEP_NAMES, type SessionManifest } from './session.js';
import { formatClock, localStamp } from './time.js';

export const HOOK_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const hookNameSchema = z.string().regex(HOOK_NAME, 'a hook name is lowercase letters, digits and dashes, at most 40, such as call-routine');
/** What a session is to a hook: a call when session.json has source.call, otherwise a walkthrough (any recording that is not a call). */
export const HOOK_MODES = ['call', 'walkthrough', 'any'] as const;
export type SessionMode = Exclude<typeof HOOK_MODES[number], 'any'>;
/** Set for the hook by polycap; a hook's own env may not change them. */
const RESERVED_ENV = ['POLYCAP_SESSION_ID', 'POLYCAP_SESSION_DIR', 'POLYCAP_HOOK'];

/**
 * What a hook does not inherit from the polycap that starts it, unless its own env sets it again:
 * polycap's secrets, and the keys and markers of a Claude session around it. A hook is the user's
 * routine on the user's own login (Robin, 2026-10-04: Claude Code runs on his subscription), but
 * started from a shell that exports ANTHROPIC_API_KEY, `claude -p` bills that key and loses his
 * claude.ai connectors; started from an agent's Bash tool, it would take the parent session's base
 * URL and identity (CLAUDECODE, CLAUDE_CODE_*). The Mac app builds a small environment of its own;
 * this covers `polycap process` and `polycap hooks run` from a terminal or an agent. Everything else
 * (PATH, SSH_AUTH_SOCK, CLAUDE_CONFIG_DIR, POLYCAP_ROOT) still reaches the hook.
 */
export const HOOK_ENV_DROPPED = {
  prefixes: ['ANTHROPIC_', 'CLAUDE_CODE_', 'CLAUDE_AGENT_SDK_'],
  names: ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'GLADIA_API_KEY', 'POLYCAP_UPLOAD_TOKEN', 'POLYCAP_REMOTE_TOKEN', 'POLYCAP_SERVER_TOKENS', 'POLYCAP_META_APP_SECRET'],
} as const;

export const droppedFromHook = (name: string) => (HOOK_ENV_DROPPED.names as readonly string[]).includes(name) || HOOK_ENV_DROPPED.prefixes.some(prefix => name.startsWith(prefix));

/** The environment a hook starts with: the inherited one less HOOK_ENV_DROPPED, then its own env, then polycap's values. */
export function hookEnvironment(inherited: NodeJS.ProcessEnv, hook: Pick<Hook, 'env'>, values: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(inherited)) if (value !== undefined && !droppedFromHook(name)) env[name] = value;
  return { ...env, ...hook.env, ...values };
}

/** `~`, `~/…` or absolute: a relative folder would depend on where polycap was started, which is `/` from the Mac app. */
const hookCwd = (cwd: string) => cwd === '~' || cwd.startsWith('~/') || isAbsolute(cwd);
/** The longest a hook may run; also how old a lock may be before it is taken for a reused pid. */
export const MAX_TIMEOUT_MINUTES = 24 * 60;

const hookSchema = z.strictObject({
  name: hookNameSchema,
  when: z.strictObject({
    mode: z.enum(HOOK_MODES).default('any'),
    /** Recordings shorter than this, by the probed length, are skipped; a lobby preview is not a call. */
    minMinutes: z.number().nonnegative().max(MAX_TIMEOUT_MINUTES).optional(),
  }).default({ mode: 'any' }),
  /** Where the command runs: `~`, `~/…` or an absolute path. Absent: the home directory. */
  cwd: z.string().min(1).max(1024).refine(hookCwd, 'cwd is ~, ~/… or an absolute path; a relative folder would depend on where polycap was started').optional(),
  /** The program and its arguments, never through a shell. {id}, {dir} and {title} are replaced inside each element. */
  run: z.array(z.string().max(100_000)).min(1).max(256).refine(run => !run.length || run[0].trim() !== '', 'run[0] is the program to start and cannot be empty'),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'an environment variable name is letters, digits and _'), z.string().max(100_000))
    .refine(env => !Object.keys(env).some(key => RESERVED_ENV.includes(key)), `${RESERVED_ENV.join(', ')} are set by polycap`).default({}),
  /** Fractions are allowed (0.5 is 30 s); past it the hook's whole process group is stopped. */
  timeoutMinutes: z.number().positive().max(MAX_TIMEOUT_MINUTES).default(30),
});
export type Hook = z.infer<typeof hookSchema>;

export const hooksFileSchema = z.strictObject({
  version: z.literal(1),
  hooks: z.array(hookSchema).max(50),
}).refine(file => new Set(file.hooks.map(h => h.name)).size === file.hooks.length, { message: 'two hooks have the same name', path: ['hooks'] });

const issues = (error: z.ZodError) => error.issues.map(i => `${i.path.length ? i.path.join('.') : '(top level)'}: ${i.message}`).join('; ');

/** Parses hooks.json text; `where` names the file in the error. */
export function parseHooks(text: string, where: string): Hook[] {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (error) { throw new UserError(`${where} is not JSON: ${error instanceof Error ? error.message : String(error)}`); }
  const result = hooksFileSchema.safeParse(raw);
  if (!result.success) throw new UserError(`${where} is not a valid hooks file (version 1, docs/MAC.md "Starting Robin's routine"): ${issues(result.error)}`);
  return result.data.hooks;
}

/**
 * The configured hooks; a missing file means none. Anything else wrong with it is an error, never a
 * guess. The file starts programs as the user and its hooks' env can hold secrets, so, like the env
 * file (config.ts), it is refused unless it is a regular file of the user's own that no one else can
 * read or write (symlinks are followed, so a dotfiles link still works).
 */
export async function loadHooks(file: string): Promise<{ file: string; found: boolean; hooks: Hook[] }> {
  if (!await exists(file)) return { file, found: false, hooks: [] };
  const info = await stat(file).catch(error => { throw new UserError(`${file} cannot be read: ${(error as Error).message}`); });
  if (!info.isFile()) throw new UserError(`${file} is not a regular file`);
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) throw new UserError(`${file} belongs to another user (uid ${info.uid}); a hooks file must be your own`);
  if (info.mode & 0o077) throw new UserError(`${file} is readable or writable by other users; run chmod 600 ${file}`);
  const text = await readFile(file, 'utf8').catch(error => { throw new UserError(`${file} cannot be read: ${(error as Error).message}`); });
  return { file, found: true, hooks: parseHooks(text, file) };
}

/** `~` and `~/…` are the home directory; nothing else is expanded. */
export const expandTilde = (path: string, home = homedir()) => path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;

export const sessionMode = (manifest: Pick<SessionManifest, 'source'>): SessionMode => manifest.source.call ? 'call' : 'walkthrough';

/**
 * Whether a hook is for this session. `undefined` when the question does not arise (a step is still
 * pending, or the hook is for the other mode): nothing is recorded. A reason when it is the session's
 * kind but left out by its filter, which is recorded as skipped so the app can say why. A failed
 * transcription holds every hook back: a routine run on a bundle without its words would write its
 * notes from nothing and be recorded done, and never run again once the words were there. A skip is
 * decided afresh, so the `process` that fixes the transcript runs the hooks; `--hook NAME` runs one
 * regardless.
 */
export function hookMatch(hook: Hook, manifest: SessionManifest): { run: true } | { run: false; skipped?: string } {
  if (isPending(manifest)) return { run: false };
  if (hook.when.mode !== 'any' && hook.when.mode !== sessionMode(manifest)) return { run: false };
  if (manifest.source.call?.short) return { run: false, skipped: 'the call is marked short: under 2 minutes, most likely a lobby preview or a mic test' };
  if (manifest.steps.transcribe.status === 'failed') return { run: false, skipped: `transcription failed; polycap process ${manifest.id} --step transcribe --force redoes it, then the hooks run` };
  const min = hook.when.minMinutes;
  if (min !== undefined && min > 0) {
    const length = manifest.media.durationMs;
    if (length === undefined) return { run: false, skipped: `its length is not known, so it cannot be checked against ${min} min` };
    if (length < min * 60_000) return { run: false, skipped: `${formatClock(length)} long, under the hook's ${min} min` };
  }
  return { run: true };
}

/**
 * {title} for a hook: Claude's few words when the summary step gave some, else for a call its app and
 * meeting code with the local start, else the id. One line, no control characters, at most 120
 * characters, and never starting with a dash, so a hook that passes it as an argument of its own
 * cannot have it read as an option.
 */
export function hookTitle(manifest: SessionManifest): string {
  const call = manifest.source.call;
  const local = localStamp(new Date(manifest.recordedAt));
  const raw = manifest.summary?.title ?? (call ? `${callTitle(call)} ${local.slice(0, 10)} ${local.slice(11, 16).replace('-', ':')}` : manifest.title);
  const clean = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[-\s]+/, '').slice(0, 120).trim();
  return clean || manifest.id;
}

export interface HookValues { id: string; dir: string; title: string }

/** {id}, {dir} and {title} replaced inside each argument; any other braces are left as written. */
export const substitute = (args: readonly string[], values: HookValues): string[] =>
  args.map(arg => arg.replace(/\{(id|dir|title)\}/g, (_, key: keyof HookValues) => values[key]));

/**
 * What a hook reads on stdin: ids, paths and the facts session.json records, never the transcript or
 * any other content (PV5). The routine opens the files itself.
 */
export async function hookInput(hook: Hook, manifest: SessionManifest, dir: string): Promise<Record<string, unknown>> {
  const paths = sessionPaths(dir);
  const files: Record<string, string> = { session: paths.manifest };
  for (const [name, path] of [['storyboard', paths.storyboard], ['transcript', paths.transcriptMd], ['transcriptJson', paths.transcriptJson], ['frames', paths.framesJson], ['markers', paths.markers], ['requests', paths.requests], ['contactSheet', paths.contactSheet]] as const) {
    if (await exists(path)) files[name] = path;
  }
  return {
    version: 1, hook: hook.name, id: manifest.id, dir, title: hookTitle(manifest), mode: sessionMode(manifest),
    recordedAt: manifest.recordedAt, durationMs: manifest.media.durationMs, hasVideo: manifest.media.hasVideo !== false,
    ...(manifest.source.call ? { call: manifest.source.call } : {}),
    marks: manifest.source.marks?.length ?? 0, frameCount: manifest.frameCount ?? 0, markerCount: manifest.markerCount ?? 0,
    ...(manifest.source.thread ? { thread: manifest.source.thread.key } : {}),
    steps: Object.fromEntries(STEP_NAMES.map(name => [name, manifest.steps[name].status])),
    files,
  };
}

/** hook-runs.json: each hook's latest run for this session, as the Mac app reads it (strict, version 1). */
export const HOOK_STATUSES = ['running', 'done', 'failed', 'timeout', 'skipped'] as const;
const isoTime = z.iso.datetime({ offset: true });
export const hookRunSchema = z.strictObject({
  status: z.enum(HOOK_STATUSES),
  startedAt: isoTime,
  finishedAt: isoTime.optional(),
  exitCode: z.number().int().optional(),
  signal: z.string().regex(/^SIG[A-Z0-9]+$/).optional(),
  /** Only while running: whose death means the run was interrupted. */
  pid: z.number().int().positive().optional(),
  /** Claude Code's session_id from `--output-format json`, for `claude --resume`. */
  agentSessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
  note: z.string().max(1000).optional(),
  /** The hook's stdout and stderr, relative to the session folder. */
  log: z.string().regex(/^hooks\/[a-z0-9][a-z0-9-]{0,39}\.log$/).optional(),
});
export type HookRun = z.infer<typeof hookRunSchema>;
export const hookRunsSchema = z.strictObject({ version: z.literal(1), runs: z.record(hookNameSchema, hookRunSchema) });
export type HookRuns = z.infer<typeof hookRunsSchema>;

export const HOOK_RUNS_FILE = 'hook-runs.json';
export const hookRunsPath = (dir: string) => join(dir, HOOK_RUNS_FILE);
export const hookLog = (name: string) => `hooks/${name}.log`;

export async function readHookRuns(dir: string): Promise<HookRuns> {
  const file = hookRunsPath(dir);
  return await exists(file) ? readJson(file, hookRunsSchema) : { version: 1, runs: {} };
}

/** A run that is over: not run again unless forced. A skip is decided again each time. */
export const isFinal = (run: HookRun | undefined) => run !== undefined && (run.status === 'done' || run.status === 'failed' || run.status === 'timeout');

/** A folder as a person pastes it into a terminal: `~/…` kept, quoted only when it has to be. */
const pasteable = (path: string) => /^[A-Za-z0-9_./~+-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;

/** How a person continues the agent's conversation: Claude Code's resume, in the hook's folder. */
export const resumeCommand = (run: HookRun, hook?: Hook) =>
  run.agentSessionId ? `${hook?.cwd ? `cd ${pasteable(hook.cwd)} && ` : ''}claude --resume ${run.agentSessionId}` : undefined;

/** One line for `polycap show` and `polycap hooks run`. */
export function hookRunLine(name: string, run: HookRun, hook?: Hook): string {
  const parts: string[] = [run.status];
  if (run.exitCode !== undefined) parts.push(`exit ${run.exitCode}`);
  if (run.signal) parts.push(run.signal);
  if (run.status === 'running' && run.pid) parts.push(`pid ${run.pid}`);
  parts.push(`${run.startedAt}${run.finishedAt && run.finishedAt !== run.startedAt ? ` to ${run.finishedAt}` : ''}`);
  if (run.note) parts.push(run.note);
  if (run.agentSessionId) parts.push(`agent session ${run.agentSessionId}`);
  const resume = resumeCommand(run, hook);
  return `${name}  ${parts.join(' · ')}${resume ? `\n    continue: ${resume}` : ''}${run.log ? `\n    log: ${run.log}` : ''}`;
}
