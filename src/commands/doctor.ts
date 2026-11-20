import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { Adb } from '../adb.js';
import { exists } from '../fsx.js';
import { installed } from '../exec.js';
import { expandTilde, hookEnvironment, loadHooks } from '../hooks.js';
import { findProgram } from '../hook-run.js';
import type { Cli } from './context.js';
import { table } from './context.js';
import { skillState } from './install-skill.js';

interface Check { name: string; required: boolean; ok: boolean; detail: string }

/**
 * Reports what is installed and what is missing, with the fix for each. Exit code 1 only for required items.
 * `skillsDir` is for tests: where the agent's skills are, ~/.claude/skills otherwise.
 */
export async function doctor(cli: Cli, options: { skillsDir?: string } = {}): Promise<boolean> {
  const { config } = cli;
  const checks: Check[] = [];
  const tool = async (name: string, bin: string, required: boolean, hint: string, args?: string[]) => {
    const ok = await installed(bin, args);
    checks.push({ name, required, ok, detail: ok ? bin : hint });
  };
  await tool('adb', config.adb, true, 'brew install --cask android-platform-tools', ['version']);
  await tool('ffmpeg', config.ffmpeg, true, 'brew install ffmpeg', ['-version']);
  await tool('ffprobe', config.ffprobe, true, 'brew install ffmpeg', ['-version']);
  if (config.transcriber === 'whisper-cpp') {
    await tool('whisper-cli', config.whisperBin, false, 'brew install whisper-cpp (or POLYCAP_TRANSCRIBER=none)', ['--help']);
    const model = await exists(config.whisperModel);
    checks.push({ name: 'whisper model', required: false, ok: model, detail: model ? config.whisperModel : `missing ${config.whisperModel}; see private/docs/HANDOVER.md` });
  } else if (config.transcriber === 'gladia') {
    checks.push({ name: 'transcriber', required: false, ok: Boolean(config.gladiaKey), detail: `Gladia at ${config.gladiaUrl}${config.gladiaKey ? '' : '; GLADIA_API_KEY missing'}` });
  } else checks.push({ name: 'transcriber', required: false, ok: true, detail: 'none (transcription disabled)' });
  checks.push({ name: 'summary', required: false, ok: true, detail: config.summarizer === 'claude' ? `Claude ${config.summaryModel} at ${config.anthropicUrl} (transcript text only)` : 'none (POLYCAP_SUMMARIZER=claude to label recordings)' });
  // Meet calls' speakers: a missing reader is said here, and the step says so too and leaves Others unnamed.
  const reader = config.speakers === 'meet' && existsSync(config.speakersBin);
  checks.push({ name: 'speakers', required: false, ok: config.speakers === 'none' || reader, detail: config.speakers === 'none' ? "none (Others' lines are not named)" : reader ? `Meet's speaking ring, read on this Mac by ${config.speakersBin}` : `${config.speakersBin} is not built: npm run mac -- speakers` });
  checks.push({ name: 'library', required: true, ok: true, detail: config.root.replace(homedir(), '~') });
  // What an agent needs beyond the tools (docs/AGENT-SETUP.md): the hosted receiver for threads and sync, and the skill.
  // Neither is required: a library of local recordings works without both. The token is checked by `polycap project list`, not here.
  checks.push({ name: 'receiver', required: false, ok: Boolean(config.remoteUrl && config.remoteToken), detail: !config.remoteUrl ? 'not set: threads and polycap sync need POLYCAP_REMOTE_URL and POLYCAP_REMOTE_TOKEN (docs/AGENT-SETUP.md)' : config.remoteToken ? `${config.remoteUrl} (threads and polycap sync; polycap project list tries the token)` : `${config.remoteUrl}, but POLYCAP_REMOTE_TOKEN is not set: threads need an agent token` });
  const skill = await skillState(options.skillsDir);
  checks.push({ name: 'skill', required: false, ...skill });
  // A hooks file that is there but wrong stops every hook, so it is required to be valid; none is fine.
  const hooksFile = config.hooksFile.replace(homedir(), '~');
  try {
    const { found, hooks } = await loadHooks(config.hooksFile);
    checks.push({ name: 'hooks', required: true, ok: true, detail: found ? `${hooks.length} in ${hooksFile}${hooks.length ? `: ${hooks.map(h => h.name).join(', ')}` : ''}` : `none (${hooksFile} not present)` });
    for (const hook of hooks) {
      const cwd = expandTilde(hook.cwd ?? '~');
      const program = await findProgram(hook.run[0], hookEnvironment(process.env, hook), cwd);
      const folder = await exists(cwd);
      checks.push({ name: `hook ${hook.name}`, required: false, ok: Boolean(program) && folder, detail: !folder ? `cwd ${hook.cwd} does not exist` : program ? `${program} in ${hook.cwd ?? '~'}` : `${hook.run[0]} is not on this PATH (a hook started by the Mac app gets the app's PATH)` });
    }
  } catch (error) {
    checks.push({ name: 'hooks', required: true, ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  let devices = 'adb unavailable';
  if (checks.find(c => c.name === 'adb')?.ok) {
    try { const list = (await new Adb(config.adb).devices()).filter(d => d.state === 'device'); devices = list.length ? list.map(d => `${d.serial}${d.model ? ` (${d.model})` : ''}`).join(', ') : 'none connected'; }
    catch (error) { devices = error instanceof Error ? error.message : String(error); }
  }
  checks.push({ name: 'devices', required: false, ok: devices !== 'none connected' && devices !== 'adb unavailable', detail: devices });
  if (cli.json) cli.print(JSON.stringify(checks, null, 2));
  else cli.print(table(checks.map(c => [c.ok ? 'ok' : c.required ? 'MISSING' : 'missing', c.name, c.detail]), ['status', 'check', 'detail']));
  return checks.every(c => c.ok || !c.required);
}
