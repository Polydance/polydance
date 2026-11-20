/**
 * Routine hooks (docs/MAC.md H1 to H3, H7): hooks.json validation and its permissions, which hooks a
 * session matches, the argument substitution, and end to end with a fake hook (a node script that
 * records its argv, env, cwd and stdin and prints Claude Code's JSON) for done, a failed exit, a
 * timeout that stops the whole process group (a grandchild that ignores SIGTERM included), polycap
 * itself stopped by a signal, once only, --force, a run interrupted by polycap stopping, the lock,
 * the environment a hook does not inherit, and the tool calls Claude Code denied. Nothing here runs
 * claude or reads the user's own hooks file.
 */
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { doctor } from '../src/commands/doctor.js';
import { hooksList, hooksRun } from '../src/commands/hooks.js';
import { importRecording } from '../src/commands/import.js';
import { show } from '../src/commands/inspect.js';
import { processCommand } from '../src/commands/process.js';
import { exec } from '../src/exec.js';
import { agentSessionId, alive, denialNote, findProgram, LOG_CAP, permissionDenials, runSessionHooks } from '../src/hook-run.js';
import { droppedFromHook, expandTilde, hookEnvironment, hookMatch, hookRunsSchema, hookTitle, loadHooks, parseHooks, readHookRuns, substitute, type Hook } from '../src/hooks.js';
import { createSession, loadSession, saveSession, STEP_NAMES, type SessionManifest } from '../src/session.js';
import { testCli, type TestCli } from './helpers/cli.js';
import { hasFfmpeg, makeVideo } from './helpers/fake-tools.js';

const ffmpeg = await hasFfmpeg();
const fixture = JSON.parse(await readFile(new URL('./fixtures/mac-call-meta.json', import.meta.url), 'utf8'));
const contract = {
  version: 1,
  hooks: [{
    name: 'call-routine', when: { mode: 'call', minMinutes: 2 }, cwd: '~/Code/calls',
    // Every step's tool, and only polycap's reading commands: `Bash(polycap *)` would let call content drive thread reply, upload and sync.
    run: ['claude', '-p', 'Process the Polydance call in {dir} with the process-call skill.', '--name', 'Call: {title}', '--output-format', 'json', '--permission-mode', 'dontAsk', '--allowedTools', 'Read Glob Grep Edit(notes/**) Bash(polycap show *) Bash(polycap transcript *) Bash(polycap frames *) Bash(git add *) Bash(git commit *) Bash(git push *)'],
    env: {}, timeoutMinutes: 30,
  }],
};
const hook = (over: Partial<Hook> & { name: string }): Hook => ({ when: { mode: 'any' }, run: ['true'], env: {}, timeoutMinutes: 30, ...over });

/** A finished session as the pipeline leaves it, without running the pipeline: a call unless `call` is null. */
async function finished(cli: TestCli, options: { call?: Record<string, unknown> | null; durationMs?: number; pending?: boolean; title?: string } = {}) {
  const file = join(cli.config.root, `polydance-mac-20261105-110002-${Math.random().toString(16).slice(2, 8)}.mp4`);
  await writeFile(file, 'not really a video');
  const call = options.call === null ? undefined : { ...fixture.call, ...options.call };
  const { dir, manifest } = await createSession(cli.config, { localFile: file, originalName: 'polydance-mac-20261105-110002.mp4', bytes: 18, source: { kind: 'import', ...(call ? { call } : {}), audioTracks: ['mic', 'app'] } });
  // Transcription skipped, so nothing reads a transcript this fake bundle does not have.
  const steps = Object.fromEntries(STEP_NAMES.map(n => [n, { status: options.pending && n === 'storyboard' ? 'pending' : n === 'transcribe' ? 'skipped' : 'done' }])) as SessionManifest['steps'];
  const done: SessionManifest = { ...manifest, steps, media: { ...manifest.media, durationMs: options.durationMs ?? 3_133_000 }, ...(options.title ? { title: options.title, summary: { title: options.title, text: 'One sentence.', model: 'claude-test' } } : {}) };
  await saveSession(dir, done);
  await writeFile(join(dir, 'storyboard.md'), '# storyboard\n');
  return { dir, manifest: done };
}

/**
 * The fake hook. It appends what it saw to $FAKE_HOOK_OUT, one JSON line per run, then behaves as
 * $FAKE_HOOK_MODE says: ok prints Claude Code's result with a session_id; denied prints one whose
 * permission_denials lists two refused calls; fail exits 3; sleep starts a grandchild in its group and
 * waits; stubborn does the same with a grandchild that ignores SIGTERM; deaf ignores SIGTERM and SIGINT
 * itself; spam prints 2 MB. `leak` is what it inherited that it should not have.
 */
const FAKE_HOOK = `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
let stdin = '';
process.stdin.on('data', c => { stdin += c; });
process.stdin.on('end', () => {
  const mode = process.env.FAKE_HOOK_MODE || 'ok';
  const pick = names => Object.fromEntries(names.map(n => [n, process.env[n]]));
  const seen = { argv: process.argv.slice(2), cwd: process.cwd(), stdin: JSON.parse(stdin), mode, pid: process.pid,
    env: pick(['POLYCAP_SESSION_ID', 'POLYCAP_SESSION_DIR', 'POLYCAP_HOOK', 'EXTRA']),
    leak: pick(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'POLYCAP_UPLOAD_TOKEN', 'GLADIA_API_KEY', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'POLYCAP_TEST_KEEP']) };
  if (mode === 'sleep') { const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); seen.grandchild = child.pid; }
  if (mode === 'stubborn') { const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000)"], { stdio: 'ignore' }); seen.grandchild = child.pid; }
  if (mode === 'deaf') { process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); }
  fs.appendFileSync(process.env.FAKE_HOOK_OUT, JSON.stringify(seen) + '\\n');
  if (mode === 'ok') { process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'notes written', session_id: 'abc-123' })); return; }
  if (mode === 'denied') { process.stdout.write(JSON.stringify({ type: 'result', is_error: false, session_id: 's1', permission_denials: [{ tool_name: 'Write', tool_use_id: 't1', tool_input: {} }, { tool_name: 'Bash', tool_use_id: 't2', tool_input: {} }] })); return; }
  if (mode === 'fail') { process.stderr.write('boom\\n'); process.exit(3); }
  if (mode === 'spam') { process.stdout.write('x'.repeat(2 * 1024 * 1024)); return; }
  if (mode === 'sleep' || mode === 'stubborn' || mode === 'deaf' || mode === 'short-sleep') setTimeout(() => {}, mode === 'short-sleep' ? 1500 : 60000);
});
`;

describe('hooks.json', () => {
  it('reads the contract example and fills in the defaults', () => {
    const [routine] = parseHooks(JSON.stringify(contract), 'hooks.json');
    expect(routine).toMatchObject({ name: 'call-routine', when: { mode: 'call', minMinutes: 2 }, cwd: '~/Code/calls', timeoutMinutes: 30, env: {} });
    const [bare] = parseHooks(JSON.stringify({ version: 1, hooks: [{ name: 'notify', run: ['say', 'done'] }] }), 'hooks.json');
    expect(bare).toEqual({ name: 'notify', when: { mode: 'any' }, run: ['say', 'done'], env: {}, timeoutMinutes: 30 });
    expect(parseHooks(JSON.stringify({ version: 1, hooks: [] }), 'hooks.json')).toEqual([]);
  });

  it('refuses anything else, naming the file and the field', () => {
    const bad = (value: unknown) => () => parseHooks(typeof value === 'string' ? value : JSON.stringify(value), '/x/hooks.json');
    const one = (over: Record<string, unknown>) => ({ version: 1, hooks: [{ ...contract.hooks[0], ...over }] });
    expect(bad('{')).toThrow(/\/x\/hooks\.json is not JSON/);
    expect(bad({ version: 2, hooks: [] })).toThrow(/\/x\/hooks\.json is not a valid hooks file.*version/);
    expect(bad({ version: 1, hooks: [], extra: true })).toThrow(/Unrecognized key.*extra/);
    expect(bad(one({ shell: true }))).toThrow(/hooks\.0: Unrecognized key.*shell/);
    expect(bad(one({ name: 'Call Routine' }))).toThrow(/hooks\.0\.name: a hook name is lowercase/);
    expect(bad(one({ run: [] }))).toThrow(/hooks\.0\.run/);
    expect(bad(one({ run: [' ', 'x'] }))).toThrow(/hooks\.0\.run: run\[0\] is the program/);
    expect(bad(one({ run: 'claude -p hi' }))).toThrow(/hooks\.0\.run/);
    expect(bad(one({ when: { mode: 'meeting' } }))).toThrow(/hooks\.0\.when\.mode/);
    expect(bad(one({ when: { mode: 'call', app: 'meet' } }))).toThrow(/hooks\.0\.when: Unrecognized key.*app/);
    expect(bad(one({ timeoutMinutes: 0 }))).toThrow(/hooks\.0\.timeoutMinutes/);
    expect(bad(one({ env: { POLYCAP_SESSION_ID: 'x' } }))).toThrow(/hooks\.0\.env: POLYCAP_SESSION_ID/);
    expect(bad(one({ env: { 'BAD-NAME': 'x' } }))).toThrow(/hooks\.0\.env/);
    expect(bad({ version: 1, hooks: [contract.hooks[0], contract.hooks[0]] })).toThrow(/two hooks have the same name/);
  });

  it('means no hooks when the file is not there', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'polycap-hooks-'));
    expect(await loadHooks(join(dir, 'hooks.json'))).toEqual({ file: join(dir, 'hooks.json'), found: false, hooks: [] });
    await writeFile(join(dir, 'hooks.json'), JSON.stringify(contract), { mode: 0o600 });
    expect((await loadHooks(join(dir, 'hooks.json'))).hooks.map(h => h.name)).toEqual(['call-routine']);
  });

  it('refuses a hooks file others can read or write, as the env file is, and one that is not a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'polycap-hooks-'));
    const file = join(dir, 'hooks.json');
    await writeFile(file, JSON.stringify({ version: 1, hooks: [{ name: 'notify', run: ['say', 'done'], env: { SLACK_TOKEN: 'xoxb-secret' } }] }), { mode: 0o600 });
    for (const mode of [0o644, 0o666, 0o640]) {
      await chmod(file, mode);
      await expect(loadHooks(file)).rejects.toThrow(`${file} is readable or writable by other users; run chmod 600 ${file}`);
    }
    await chmod(file, 0o600);
    expect((await loadHooks(file)).hooks.map(h => h.name)).toEqual(['notify']);
    // Followed through a symlink, as a dotfiles link would be.
    await symlink(file, join(dir, 'linked.json'));
    expect((await loadHooks(join(dir, 'linked.json'))).found).toBe(true);
    await mkdir(join(dir, 'folder.json'), { mode: 0o700 });
    await expect(loadHooks(join(dir, 'folder.json'))).rejects.toThrow(/folder\.json is not a regular file/);
  });

  it('takes a cwd of ~, ~/… or an absolute path, never one relative to wherever polycap started', () => {
    const one = (cwd: string) => parseHooks(JSON.stringify({ version: 1, hooks: [{ name: 'x', run: ['true'], cwd }] }), 'hooks.json')[0].cwd;
    expect(['~', '~/Code/calls', '/Users/r/Code/calls'].map(one)).toEqual(['~', '~/Code/calls', '/Users/r/Code/calls']);
    for (const bad of ['Code/calls', './calls', '~other/calls', '../x']) expect(() => one(bad)).toThrow(/hooks\.0\.cwd: cwd is ~, ~\/… or an absolute path/);
  });
});

describe('which hooks a session matches, and what they are given', () => {
  let cli: TestCli;
  beforeAll(async () => { cli = await testCli(); });

  it('matches by mode and length, never a short call, never while a step is pending', async () => {
    const call = (await finished(cli)).manifest;
    const walk = (await finished(cli, { call: null, durationMs: 30_000 })).manifest;
    const [routine] = parseHooks(JSON.stringify(contract), 'hooks.json');
    expect(hookMatch(routine, call)).toEqual({ run: true });
    expect(hookMatch(routine, walk)).toEqual({ run: false });
    expect(hookMatch(hook({ name: 'w', when: { mode: 'walkthrough' } }), walk)).toEqual({ run: true });
    expect(hookMatch(hook({ name: 'w', when: { mode: 'walkthrough' } }), call)).toEqual({ run: false });
    expect(hookMatch(hook({ name: 'a' }), walk)).toEqual({ run: true });
    expect(hookMatch(routine, { ...call, media: { ...call.media, durationMs: 119_000 } })).toEqual({ run: false, skipped: "01:59 long, under the hook's 2 min" });
    expect(hookMatch(routine, { ...call, media: { ...call.media, durationMs: 120_000 } })).toEqual({ run: true });
    expect(hookMatch(routine, { ...call, media: { ...call.media, durationMs: undefined } }).run).toBe(false);
    expect(hookMatch(hook({ name: 'a' }), { ...call, source: { ...call.source, call: { ...call.source.call!, short: true } } })).toEqual({ run: false, skipped: expect.stringMatching(/marked short/) });
    expect(hookMatch(hook({ name: 'a' }), { ...call, steps: { ...call.steps, frames: { status: 'pending' } } })).toEqual({ run: false });
    // A failed transcription holds every hook back, as a skip, which is decided again next time.
    expect(hookMatch(routine, { ...call, steps: { ...call.steps, transcribe: { status: 'failed', error: 'no model' } } })).toEqual({ run: false, skipped: `transcription failed; polycap process ${call.id} --step transcribe --force redoes it, then the hooks run` });
    expect(hookMatch(routine, { ...call, steps: { ...call.steps, transcribe: { status: 'skipped' } } })).toEqual({ run: true });
  });

  it('leaves polycap\'s secrets and a surrounding Claude session out of a hook\'s environment, unless the hook sets them', () => {
    const inherited = { PATH: '/usr/bin', HOME: '/Users/r', SSH_AUTH_SOCK: '/tmp/agent', CLAUDE_CONFIG_DIR: '/Users/r/.claude', POLYCAP_ROOT: '/lib',
      ANTHROPIC_API_KEY: 'sk-must-not-reach-claude', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'http://proxy', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_AGENT_SDK_VERSION: '1', CLAUDE_PID: '9', CLAUDE_EFFORT: 'high',
      GLADIA_API_KEY: 'g', POLYCAP_UPLOAD_TOKEN: 'u', POLYCAP_REMOTE_TOKEN: 'r', POLYCAP_SERVER_TOKENS: '[]', POLYCAP_META_APP_SECRET: 'm' };
    expect(hookEnvironment(inherited, { env: {} }, { POLYCAP_HOOK: 'x' })).toEqual({ PATH: '/usr/bin', HOME: '/Users/r', SSH_AUTH_SOCK: '/tmp/agent', CLAUDE_CONFIG_DIR: '/Users/r/.claude', POLYCAP_ROOT: '/lib', POLYCAP_HOOK: 'x' });
    expect(hookEnvironment(inherited, { env: { ANTHROPIC_API_KEY: 'sk-the-hooks-own' } }).ANTHROPIC_API_KEY).toBe('sk-the-hooks-own');
    expect(['ANTHROPIC_API_KEY', 'CLAUDECODE', 'CLAUDE_CODE_OAUTH_TOKEN', 'POLYCAP_UPLOAD_TOKEN'].every(droppedFromHook)).toBe(true);
    expect(['CLAUDE_CONFIG_DIR', 'PATH', 'POLYCAP_ROOT'].some(droppedFromHook)).toBe(false);
  });

  it('substitutes {id}, {dir} and {title} inside single arguments, and nothing else', () => {
    const values = { id: '2026-11-05T11-00-02_meet', dir: '/lib/sessions/x y', title: 'Design review; rm -rf ~' };
    expect(substitute(['claude', '-p', 'Process {dir} now ({id})', '--name', 'Call: {title}', '{dir}', '{other} {{id}}', '{ID}'], values))
      .toEqual(['claude', '-p', 'Process /lib/sessions/x y now (2026-11-05T11-00-02_meet)', '--name', 'Call: Design review; rm -rf ~', '/lib/sessions/x y', '{other} {2026-11-05T11-00-02_meet}', '{ID}']);
    expect(expandTilde('~/Code/calls', '/Users/r')).toBe('/Users/r/Code/calls');
    expect(expandTilde('~', '/Users/r')).toBe('/Users/r');
    expect(expandTilde('~other/x', '/Users/r')).toBe('~other/x');
    expect(expandTilde('/abs', '/Users/r')).toBe('/abs');
  });

  it('gives a title that is one line and can never be read as an option', async () => {
    const { manifest } = await finished(cli);
    expect(hookTitle(manifest)).toMatch(/^Google Meet abc-defg-hij in arc 2026-11-05 \d\d:\d\d$/);
    expect(hookTitle({ ...manifest, summary: { title: '--dangerously-skip-permissions', text: 'x', model: 'm' } })).toBe('dangerously-skip-permissions');
    expect(hookTitle({ ...manifest, summary: { title: 'Line one\nline\ttwo\u0000', text: 'x', model: 'm' } })).toBe('Line one line two');
    expect(hookTitle({ ...manifest, summary: { title: ' - - ', text: 'x', model: 'm' } })).toBe(manifest.id);
    expect(hookTitle({ ...manifest, source: { ...manifest.source, call: undefined } })).toBe(manifest.id);
  });

  it('reads the agent session from Claude Code json and stream-json, and nothing that is not an id', () => {
    expect(agentSessionId(JSON.stringify({ type: 'result', session_id: '0d9f3c3e-1b2a-4c5d-8e9f-0a1b2c3d4e5f' }))).toBe('0d9f3c3e-1b2a-4c5d-8e9f-0a1b2c3d4e5f');
    expect(agentSessionId('{"type":"system"}\n{"type":"result","session_id":"s1"}\n')).toBe('s1');
    expect(agentSessionId(JSON.stringify({ session_id: 'not an id; rm' }))).toBeUndefined();
    expect(agentSessionId('plain text')).toBeUndefined();
    expect(agentSessionId('')).toBeUndefined();
  });

  it('reads the tool calls Claude Code denied, from json and stream-json', () => {
    expect(permissionDenials(JSON.stringify({ session_id: 's1', permission_denials: [{ tool_name: 'Write' }, { tool_name: 'Bash' }, { tool_name: 'Write' }] }))).toEqual({ count: 3, tools: ['Write', 'Bash'] });
    expect(permissionDenials('{"type":"system"}\n{"type":"result","session_id":"s1","permission_denials":[{"tool_name":"mcp__slack__draft"}]}\n')).toEqual({ count: 1, tools: ['mcp__slack__draft'] });
    expect(permissionDenials(JSON.stringify({ session_id: 's1', permission_denials: [] }))).toEqual({ count: 0, tools: [] });
    expect(permissionDenials(JSON.stringify({ session_id: 's1' }))).toBeUndefined();
    expect(permissionDenials('plain text')).toBeUndefined();
    // A name that is not a tool's is counted, not repeated.
    expect(permissionDenials(JSON.stringify({ permission_denials: [{ tool_name: 'Write; rm -rf ~' }] }))).toEqual({ count: 1, tools: [] });
    expect(denialNote({ count: 2, tools: ['Write', 'Bash'] })).toBe('claude denied 2 tool calls (Write, Bash)');
    expect(denialNote({ count: 1, tools: [] })).toBe('claude denied 1 tool call');
    expect(denialNote({ count: 0, tools: [] })).toBeUndefined();
  });

  it('finds a program as spawn would, for doctor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'polycap-path-'));
    await writeFile(join(dir, 'tool'), '#!/bin/sh\n'); await chmod(join(dir, 'tool'), 0o755);
    await writeFile(join(dir, 'plain'), 'x');
    expect(await findProgram('tool', { PATH: `/nowhere:${dir}` }, '/')).toBe(join(dir, 'tool'));
    expect(await findProgram('plain', { PATH: dir }, '/')).toBeUndefined();
    expect(await findProgram('./tool', { PATH: '' }, dir)).toBe(join(dir, 'tool'));
    expect(await findProgram('missing', { PATH: dir }, '/')).toBeUndefined();
  });
});

describe('running hooks with a fake hook', () => {
  let work: string; let script: string;
  beforeAll(async () => {
    work = await realpath(await mkdtemp(join(tmpdir(), 'polycap-hook-')));
    script = join(work, 'fake-hook.cjs');
    await writeFile(script, FAKE_HOOK);
  });
  /** A CLI whose hooks file holds these hooks, all running the fake with its output in its own file. */
  const setup = async (hooks: (Partial<Hook> & { name: string; mode?: string })[]) => {
    const cli = await testCli();
    const out = join(cli.config.root, 'fake-hook.jsonl');
    const cwd = join(work, `cwd-${Math.random().toString(16).slice(2, 8)}`);
    await mkdir(cwd);
    const file = { version: 1, hooks: hooks.map(({ mode, ...h }) => ({ cwd, run: [process.execPath, script, '--dir', '{dir}', '--name', 'Call: {title}', '{id}'], env: { FAKE_HOOK_OUT: out, FAKE_HOOK_MODE: mode ?? 'ok', EXTRA: 'from the hook' }, ...h })) };
    // Private, as the Mac app writes it: anything else is refused.
    await writeFile(cli.config.hooksFile, JSON.stringify(file), { mode: 0o600 });
    const seen = async () => (await readFile(out, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, any>);
    return { cli, out, cwd, seen };
  };

  it('runs a matching hook once: argv, env, cwd and stdin as the contract says, the outcome and agent session recorded', async () => {
    const { cli, cwd, seen } = await setup([{ name: 'call-routine', when: { mode: 'call', minMinutes: 2 } }]);
    const { dir, manifest } = await finished(cli, { title: 'Design review' });
    const outcome = await runSessionHooks(cli.config, dir);
    expect(outcome).toMatchObject({ id: manifest.id, ran: ['call-routine'], notRun: {} });
    const runs = hookRunsSchema.parse(JSON.parse(await readFile(join(dir, 'hook-runs.json'), 'utf8')));
    expect(runs.runs['call-routine']).toEqual({ status: 'done', startedAt: expect.any(String), finishedAt: expect.any(String), exitCode: 0, agentSessionId: 'abc-123', log: 'hooks/call-routine.log' });
    expect(Object.keys(JSON.parse(await readFile(join(dir, 'hook-runs.json'), 'utf8')))).toEqual(['version', 'runs']);
    const [run] = await seen();
    expect(run.argv).toEqual(['--dir', dir, '--name', 'Call: Design review', manifest.id]);
    expect(run.cwd).toBe(cwd);
    expect(run.env).toEqual({ POLYCAP_SESSION_ID: manifest.id, POLYCAP_SESSION_DIR: dir, POLYCAP_HOOK: 'call-routine', EXTRA: 'from the hook' });
    expect(run.stdin).toMatchObject({ version: 1, hook: 'call-routine', id: manifest.id, dir, title: 'Design review', mode: 'call', durationMs: 3_133_000, call: { meetingCode: 'abc-defg-hij' }, steps: { storyboard: 'done', transcribe: 'skipped' }, files: { session: join(dir, 'session.json'), storyboard: join(dir, 'storyboard.md') } });
    // Paths and facts only: no summary text, no transcript.
    expect(JSON.stringify(run.stdin)).not.toContain('One sentence.');
    // Private: the record and the log 0600, the hooks folder 0700, the lock gone.
    expect((await stat(join(dir, 'hook-runs.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'hooks'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'hooks', 'call-routine.log'))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(dir, 'hooks', 'call-routine.log'), 'utf8')).toMatch(/^# polycap hook call-routine for .*\n\{"type":"result".*"session_id":"abc-123"\}$/);
    await expect(stat(join(dir, 'hooks', '.lock'))).rejects.toThrow();

    // Once per session per hook; --force runs it again.
    const again = await runSessionHooks(cli.config, dir);
    expect(again.ran).toEqual([]);
    expect(again.notRun['call-routine']).toMatch(/^already done .*--force runs it again$/);
    expect(await seen()).toHaveLength(1);
    expect((await runSessionHooks(cli.config, dir, { force: true })).ran).toEqual(['call-routine']);
    expect(await seen()).toHaveLength(2);

    // show names the agent's session and how to continue it, in the hook's folder.
    await show(cli, manifest.id);
    const shown = cli.lines.join('\n');
    expect(shown).toMatch(/hooks:\n {2}call-routine {2}done · exit 0 · .* · agent session abc-123\n {6}continue: cd .*cwd-\w+ && claude --resume abc-123\n {6}log: hooks\/call-routine\.log/);
  });

  it('records a failed exit and still runs the next hook; skips a short call and a call under the minimum', async () => {
    const { cli, seen } = await setup([{ name: 'first', mode: 'fail' }, { name: 'second' }, { name: 'long-only', when: { mode: 'call', minMinutes: 60 } }, { name: 'walks', when: { mode: 'walkthrough' } }]);
    const { dir } = await finished(cli);
    const outcome = await runSessionHooks(cli.config, dir);
    expect(outcome.ran).toEqual(['first', 'second']);
    expect(outcome.notRun).toEqual({ 'long-only': "52:13 long, under the hook's 60 min", walks: 'for walkthroughs only' });
    const { runs } = await readHookRuns(dir);
    expect(runs.first).toMatchObject({ status: 'failed', exitCode: 3 });
    expect(runs.first.agentSessionId).toBeUndefined();
    expect(runs.second).toMatchObject({ status: 'done', exitCode: 0 });
    expect(runs['long-only']).toMatchObject({ status: 'skipped', note: "52:13 long, under the hook's 60 min" });
    expect(runs.walks).toBeUndefined();
    expect(await readFile(join(dir, 'hooks', 'first.log'), 'utf8')).toContain('boom');
    expect((await seen()).map(s => s.env.POLYCAP_HOOK)).toEqual(['first', 'second']);

    const short = await finished(cli, { call: { short: true } });
    const skipped = await runSessionHooks(cli.config, short.dir);
    expect(skipped.ran).toEqual([]);
    expect((await readHookRuns(short.dir)).runs.second).toMatchObject({ status: 'skipped', note: expect.stringMatching(/marked short/) });
    // Named, a hook runs whatever its filter says; a pending step still stops it.
    expect((await runSessionHooks(cli.config, short.dir, { only: 'second' })).ran).toEqual(['second']);
    const pending = await finished(cli, { pending: true });
    expect(await runSessionHooks(cli.config, pending.dir, { only: 'second' })).toMatchObject({ ran: [], notRun: { second: 'steps are still pending' } });
    await expect(stat(join(pending.dir, 'hook-runs.json'))).rejects.toThrow();
    await expect(runSessionHooks(cli.config, pending.dir, { only: 'nope' })).rejects.toThrow(/no hook named nope .*first, second, long-only, walks/);
  });

  it('stops a hook past its timeout with its whole process group', async () => {
    const { cli, seen } = await setup([{ name: 'slow', mode: 'sleep', timeoutMinutes: 0.02 }]);
    const { dir } = await finished(cli);
    const started = Date.now();
    const outcome = await runSessionHooks(cli.config, dir, { killGraceMs: 500 });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(outcome.runs.slow).toMatchObject({ status: 'timeout', signal: 'SIGTERM', note: 'stopped after 0.02 min', log: 'hooks/slow.log' });
    expect(outcome.runs.slow.exitCode).toBeUndefined();
    const [run] = await seen();
    // The grandchild it started went with it.
    for (let i = 0; i < 20 && alive(run.grandchild); i++) await new Promise(r => setTimeout(r, 100));
    expect(alive(run.grandchild)).toBe(false);
  });

  it('SIGKILLs the group after the grace even when the hook went on the SIGTERM, so a grandchild that ignores it does not outlive the run', async () => {
    const { cli, seen } = await setup([{ name: 'slow', mode: 'stubborn', timeoutMinutes: 0.02 }]);
    const { dir } = await finished(cli);
    const started = Date.now();
    // A grace longer than the 2 s polycap waits for a hook's pipes, which used to cancel the SIGKILL.
    const outcome = await runSessionHooks(cli.config, dir, { killGraceMs: 2500 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1200 + 2500 - 100);
    expect(outcome.runs.slow).toMatchObject({ status: 'timeout', signal: 'SIGTERM', note: 'stopped after 0.02 min' });
    const [run] = await seen();
    for (let i = 0; i < 20 && alive(run.grandchild); i++) await new Promise(r => setTimeout(r, 50));
    expect(alive(run.grandchild)).toBe(false);
  });

  it('keeps polycap\'s secrets and a surrounding Claude session out of the hook, and gives it what its own env sets', async () => {
    const saved = Object.fromEntries(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'POLYCAP_UPLOAD_TOKEN', 'GLADIA_API_KEY', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'POLYCAP_TEST_KEEP'].map(n => [n, process.env[n]]));
    Object.assign(process.env, { ANTHROPIC_API_KEY: 'sk-must-not-reach-claude', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', POLYCAP_UPLOAD_TOKEN: 'polycap_must_not_leak', GLADIA_API_KEY: 'g-must-not-leak', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'parent-session', POLYCAP_TEST_KEEP: 'kept' });
    try {
      const { cli, seen } = await setup([{ name: 'plain' }, { name: 'own-key', env: { ANTHROPIC_API_KEY: 'sk-the-hooks-own' } }]);
      const { dir } = await finished(cli);
      // The fake's own output file and mode come from its env, so they are added back for the second hook.
      const file = JSON.parse(await readFile(cli.config.hooksFile, 'utf8')) as { hooks: Hook[] };
      file.hooks[1].env = { ...file.hooks[0].env, ANTHROPIC_API_KEY: 'sk-the-hooks-own' };
      await writeFile(cli.config.hooksFile, JSON.stringify(file));
      expect((await runSessionHooks(cli.config, dir)).ran).toEqual(['plain', 'own-key']);
      const [plain, own] = await seen();
      expect(plain.leak).toEqual({ POLYCAP_TEST_KEEP: 'kept' });
      expect(own.leak).toEqual({ ANTHROPIC_API_KEY: 'sk-the-hooks-own', POLYCAP_TEST_KEEP: 'kept' });
    } finally {
      for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });

  it('records the tool calls Claude Code denied in the note of a run that still finished', async () => {
    const { cli } = await setup([{ name: 'call-routine', mode: 'denied' }]);
    const { dir } = await finished(cli);
    const { runs } = await runSessionHooks(cli.config, dir);
    expect(runs['call-routine']).toMatchObject({ status: 'done', exitCode: 0, agentSessionId: 's1', note: 'claude denied 2 tool calls (Write, Bash)' });
  });

  it('holds the hooks back while transcription has failed, and runs them once it is fixed', async () => {
    const { cli, seen } = await setup([{ name: 'call-routine' }]);
    const { dir, manifest } = await finished(cli);
    await saveSession(dir, { ...manifest, steps: { ...manifest.steps, transcribe: { status: 'failed', error: 'Whisper model not found' } } });
    const held = await runSessionHooks(cli.config, dir);
    expect(held.ran).toEqual([]);
    expect(held.runs['call-routine']).toMatchObject({ status: 'skipped', note: expect.stringMatching(/^transcription failed; polycap process .* --step transcribe --force redoes it/) });
    expect(await seen()).toHaveLength(0);
    // The transcript is made: the skip is not final, so the next run of the hooks starts it.
    await saveSession(dir, { ...manifest, steps: { ...manifest.steps, transcribe: { status: 'done' } } });
    expect((await runSessionHooks(cli.config, dir)).runs['call-routine'].status).toBe('done');
    expect(await seen()).toHaveLength(1);
  });

  it('stops the hook\'s group when polycap gets a signal, kills it after a short grace when it ignores SIGTERM, and records why', async () => {
    const { cli, seen } = await setup([{ name: 'call-routine', mode: 'deaf', timeoutMinutes: 1 }]);
    const { dir, manifest } = await finished(cli);
    const home = await mkdtemp(join(tmpdir(), 'polycap-home-'));
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, POLYCAP_ROOT: cli.config.root, POLYCAP_HOOKS: cli.config.hooksFile, POLYCAP_TRANSCRIBER: 'none' };
    const polycap = spawn(process.execPath, [new URL('../bin/polycap.js', import.meta.url).pathname, 'hooks', 'run', manifest.id, '--force', '--json'], { env, cwd: home, stdio: 'ignore' });
    const exited = new Promise<number | null>(resolve => polycap.once('exit', code => resolve(code)));
    for (let i = 0; i < 200 && (await readHookRuns(dir)).runs['call-routine']?.status !== 'running'; i++) await new Promise(r => setTimeout(r, 50));
    const running = (await readHookRuns(dir)).runs['call-routine'];
    expect(running).toMatchObject({ status: 'running', pid: expect.any(Number) });
    // Let the fake set its handlers before it is signalled.
    for (let i = 0; i < 100 && !(await seen()).length; i++) await new Promise(r => setTimeout(r, 50));
    const signalled = Date.now();
    polycap.kill('SIGINT');
    expect(await exited).toBe(130);
    // The 3 s grace, not the hook's minute: the hook ignored the SIGTERM and was killed.
    expect(Date.now() - signalled).toBeLessThan(3000 + 3000);
    expect(alive(running.pid!)).toBe(false);
    expect((await readHookRuns(dir)).runs['call-routine']).toMatchObject({ status: 'failed', signal: 'SIGKILL', note: 'stopped: polycap got SIGINT' });
  }, 20_000);

  it('marks a run left running by a polycap that stopped as interrupted, and does not run it again unless forced', async () => {
    const { cli, seen } = await setup([{ name: 'call-routine' }]);
    const { dir } = await finished(cli);
    const gone = spawn(process.execPath, ['-e', '0']);
    const pid = await new Promise<number>(resolve => gone.once('exit', () => resolve(gone.pid!)));
    await writeFile(join(dir, 'hook-runs.json'), JSON.stringify({ version: 1, runs: { 'call-routine': { status: 'running', startedAt: '2026-11-05T12:00:00.000Z', pid, log: 'hooks/call-routine.log' } } }), { mode: 0o600 });
    const outcome = await runSessionHooks(cli.config, dir);
    expect(outcome.ran).toEqual([]);
    expect(outcome.runs['call-routine']).toEqual({ status: 'failed', startedAt: '2026-11-05T12:00:00.000Z', finishedAt: expect.any(String), note: 'interrupted', log: 'hooks/call-routine.log' });
    expect(await seen()).toHaveLength(0);
    expect((await runSessionHooks(cli.config, dir)).ran).toEqual([]);
    expect((await runSessionHooks(cli.config, dir, { force: true })).runs['call-routine'].status).toBe('done');
    expect(await seen()).toHaveLength(1);
  });

  it('lets one polycap at a time run a session\'s hooks, and takes over a lock its holder left behind', async () => {
    const { cli, seen } = await setup([{ name: 'call-routine', mode: 'short-sleep' }]);
    const { dir } = await finished(cli);
    const first = runSessionHooks(cli.config, dir);
    for (let i = 0; i < 50 && (await readHookRuns(dir)).runs['call-routine']?.status !== 'running'; i++) await new Promise(r => setTimeout(r, 50));
    expect((await readHookRuns(dir)).runs['call-routine']).toMatchObject({ status: 'running', pid: expect.any(Number) });
    const second = await runSessionHooks(cli.config, dir, { force: true });
    expect(second.busy).toMatch(new RegExp(`polycap \\(pid ${process.pid}\\) has been running this session's hooks since`));
    expect(second.ran).toEqual([]);
    expect((await first).runs['call-routine'].status).toBe('done');
    expect(await seen()).toHaveLength(1);

    const other = await finished(cli);
    const gone = spawn(process.execPath, ['-e', '0']);
    const pid = await new Promise<number>(resolve => gone.once('exit', () => resolve(gone.pid!)));
    await mkdir(join(other.dir, 'hooks'), { mode: 0o700 });
    await writeFile(join(other.dir, 'hooks', '.lock'), JSON.stringify({ pid, at: new Date().toISOString() }));
    expect((await runSessionHooks(cli.config, other.dir)).ran).toEqual(['call-routine']);
    await expect(stat(join(other.dir, 'hooks', '.lock'))).rejects.toThrow();
  });

  it('records a program that cannot start, a missing folder, and caps the log at 1 MB', async () => {
    const { cli } = await setup([{ name: 'missing', run: ['polycap-no-such-program-here'] }, { name: 'nowhere', cwd: join(work, 'no-such-folder') }, { name: 'spam', mode: 'spam' }]);
    const { dir } = await finished(cli);
    const { runs } = await runSessionHooks(cli.config, dir);
    expect(runs.missing).toMatchObject({ status: 'failed', note: expect.stringMatching(/^polycap-no-such-program-here could not be started: not found/) });
    expect(runs.nowhere).toMatchObject({ status: 'failed', note: expect.stringMatching(/no-such-folder is not a folder$/) });
    expect(runs.spam).toMatchObject({ status: 'done', note: `log capped at 1 MB (${2 * 1024 * 1024 - LOG_CAP} bytes not kept)` });
    const size = (await stat(join(dir, 'hooks', 'spam.log'))).size;
    expect(size).toBeGreaterThan(LOG_CAP);
    expect(size).toBeLessThan(LOG_CAP + 1000);
  });

  it('runs from polycap process for a session named or just finished, never for --all over finished bundles, and not with --no-hooks', async () => {
    const { cli, seen } = await setup([{ name: 'any-session' }]);
    const named = await finished(cli, { call: null });
    expect(await processCommand({ ...cli, print: () => {} }, { refs: [], all: true, force: false })).toHaveLength(1);
    expect(await seen()).toHaveLength(0);
    await processCommand({ ...cli, print: () => {} }, { refs: [named.manifest.id], force: false, hooks: false });
    expect(await seen()).toHaveLength(0);
    const lines: string[] = [];
    await processCommand({ ...cli, json: true, print: line => lines.push(line) }, { refs: [named.manifest.id], force: false });
    expect(await seen()).toHaveLength(1);
    expect(JSON.parse(lines.at(-1)!)[0]).toMatchObject({ id: named.manifest.id, hooks: { 'any-session': { status: 'done', agentSessionId: 'abc-123' } } });

    // A bad hooks file: the pipeline still runs, then the error says why no hook ran.
    await writeFile(cli.config.hooksFile, '{"version": 1, "hooks": [{"name": "x"}]}');
    await expect(processCommand({ ...cli, print: () => {} }, { refs: [named.manifest.id], force: false })).rejects.toThrow(/The pipeline ran, but no hooks were run: .*hooks\.0\.run/);
  });

  it.skipIf(!ffmpeg)('runs the hooks when polycap process finishes a pipeline it started', async () => {
    const { cli, seen } = await setup([{ name: 'walks', when: { mode: 'walkthrough' } }]);
    const quiet = { ...cli, print: () => {} };
    const video = join(cli.config.root, 'clip.mp4');
    await makeVideo(video, 2);
    const session = await importRecording(quiet, video, {});
    const [manifest] = await processCommand({ ...quiet, config: { ...cli.config, transcriber: 'none' } }, { refs: [], force: false });
    expect(manifest.id).toBe(session.manifest.id);
    expect((await seen()).map(s => s.stdin.id)).toEqual([session.manifest.id]);
    expect((await readHookRuns(session.dir)).runs.walks.status).toBe('done');
    expect((await loadSession(session.dir)).steps.storyboard.status).toBe('done');
  });

  it('polycap hooks list and hooks run, as the Mac app calls them', async () => {
    const { cli, seen } = await setup([{ name: 'call-routine', env: { FAKE_HOOK_OUT: 'x', SECRET_TOKEN: 'do-not-print' } as Record<string, string> }]);
    const lines: string[] = [];
    await hooksList({ ...cli, json: true, print: line => lines.push(line) });
    const listed = JSON.parse(lines[0]);
    expect(listed).toMatchObject({ file: cli.config.hooksFile, found: true, hooks: [{ name: 'call-routine', when: { mode: 'any' }, timeoutMinutes: 30, envNames: ['FAKE_HOOK_OUT', 'SECRET_TOKEN'] }] });
    expect(lines[0]).not.toContain('do-not-print');
    // Put the fake's output back where seen() reads it, then run by hand.
    const real = await setup([{ name: 'call-routine' }]);
    const { manifest } = await finished(real.cli);
    const out: string[] = [];
    const ran = await hooksRun({ ...real.cli, json: true, print: line => out.push(line) }, manifest.id, { force: true });
    expect(ran.ran).toEqual(['call-routine']);
    expect(JSON.parse(out[0])).toMatchObject({ id: manifest.id, ran: ['call-routine'], runs: { 'call-routine': { status: 'done', agentSessionId: 'abc-123' } } });
    expect(await real.seen()).toHaveLength(1);
    expect(await seen()).toHaveLength(0);
    const pending = await finished(real.cli, { pending: true });
    await expect(hooksRun(real.cli, pending.manifest.id)).rejects.toThrow(/is not finished \(storyboard pending\)/);
  });

  it('runs as the Mac app runs it: node bin/polycap.js, argument arrays, JSON on stdout', async () => {
    const { cli, seen } = await setup([{ name: 'call-routine', when: { mode: 'call', minMinutes: 2 } }]);
    const { manifest } = await finished(cli);
    const home = await mkdtemp(join(tmpdir(), 'polycap-home-'));
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, POLYCAP_ROOT: cli.config.root, POLYCAP_HOOKS: cli.config.hooksFile, POLYCAP_TRANSCRIBER: 'none' };
    const polycap = (...args: string[]) => exec(process.execPath, [new URL('../bin/polycap.js', import.meta.url).pathname, ...args], { env, cwd: home, allowFailure: true, timeoutMs: 120_000 });
    const listed = await polycap('hooks', 'list', '--json');
    expect(listed.code, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout).hooks.map((h: Hook) => h.name)).toEqual(['call-routine']);
    const processed = await polycap('process', manifest.id, '--json');
    expect(processed.code, processed.stderr).toBe(0);
    expect(processed.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(processed.stdout)[0].hooks['call-routine']).toMatchObject({ status: 'done', agentSessionId: 'abc-123' });
    const rerun = await polycap('hooks', 'run', manifest.id, '--hook', 'call-routine', '--force', '--json');
    expect(rerun.code, rerun.stderr).toBe(0);
    expect(JSON.parse(rerun.stdout)).toMatchObject({ id: manifest.id, ran: ['call-routine'], runs: { 'call-routine': { status: 'done' } } });
    expect(await seen()).toHaveLength(2);
    const unknown = await polycap('hooks', 'run', manifest.id, '--hook', 'nope', '--json');
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('no hook named nope');
  });

  it('doctor checks the hooks file and each hook\'s program and folder', async () => {
    const { cli } = await setup([{ name: 'call-routine' }, { name: 'gone', run: ['polycap-no-such-program-here'] }]);
    await doctor(cli);
    const text = cli.lines.join('\n');
    expect(text).toMatch(/ok\s+hooks\s+2 in .*: call-routine, gone/);
    expect(text).toMatch(new RegExp(`ok\\s+hook call-routine\\s+${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(text).toMatch(/missing\s+hook gone\s+polycap-no-such-program-here is not on this PATH/);
    await writeFile(cli.config.hooksFile, '{"version": 1, "hooks": "none"}');
    const broken = await testCli({ POLYCAP_HOOKS: cli.config.hooksFile });
    expect(await doctor(broken)).toBe(false);
    expect(broken.lines.join('\n')).toMatch(/MISSING\s+hooks\s+.*hooks\.json is not a valid hooks file/);
    const none = await testCli();
    await doctor(none);
    expect(none.lines.join('\n')).toMatch(/ok\s+hooks\s+none \(.*hooks\.json not present\)/);
  });
});

describe('the test CLI never reads the user\'s own hooks', () => {
  it('points POLYCAP_HOOKS into its temp root', async () => {
    const cli = await testCli();
    expect(cli.config.hooksFile.startsWith(cli.config.root)).toBe(true);
    expect(cli.config.hooksFile.startsWith(join(homedir(), '.config'))).toBe(false);
  });
});
