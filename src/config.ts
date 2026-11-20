import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateDir } from './fsx.js';
import { MODEL_MAX_BYTES } from './glb.js';
import { PHOTO_CEILING_BYTES, PHOTO_MAX_BYTES } from './photo.js';

export type TranscriberKind = 'whisper-cpp' | 'gladia' | 'none';
export type SummarizerKind = 'claude' | 'none';
export interface Config {
  root: string; raw: string; sessions: string; work: string; logs: string; models: string; ledgerFile: string;
  /** Hosted receiver only: one folder per upload while it arrives, the threads with their event feed, and the 3D models and photos pushed to them. */
  uploads: string; threadsDir: string; threadModels: string; threadPhotos: string;
  /** The CLI's copies of thread photos, one folder per thread, saved by `polycap thread show` for an agent to read. */
  photos: string;
  adb: string; ffmpeg: string; ffprobe: string;
  transcriber: TranscriberKind; whisperBin: string; whisperModel: string; language: string; threads: number;
  /** Gladia's pre-recorded API; the key comes from GLADIA_API_KEY and is never logged. */
  gladiaKey?: string; gladiaUrl: string; gladiaDeleteJobs: boolean;
  /** A title and one sentence per recording from Claude; ANTHROPIC_API_KEY is never logged. Off unless set to claude. */
  summarizer: SummarizerKind; anthropicKey?: string; anthropicUrl: string; summaryModel: string;
  /** What a pointing frame shows, named by Claude from the frame: off unless set to claude, since frames go to Anthropic. */
  pointing: SummarizerKind; pointingModel: string;
  maxFrames: number; frameWidth: number; intervalMs: number;
  /**
   * Scene-change frames (docs/MAC.md P5): for calls by default, for every recording, or none. Headset
   * recordings are not screens: every head turn would be a scene. The threshold is ffmpeg's scene score
   * (0 to 1, see pipeline/scenes.ts) and maxScenes caps them apart from maxFrames.
   */
  scenes: 'calls' | 'all' | 'none'; sceneThreshold: number; maxScenes: number;
  /**
   * Who of the Others spoke in a Meet call, from Meet's speaking ring (docs/MAC.md P3a): `meet` reads it
   * with polydance-speakers on this Mac (built by `npm run mac -- speakers`), `none` leaves Others unnamed.
   */
  speakers: 'meet' | 'none'; speakersBin: string;
  stableMs: number; minAgeMs: number;
  deviceFolders: string[] | null;
  /** `polycap sync`: where the hosted receiver is and the read token for it. */
  remoteUrl?: string; remoteToken?: string;
  /**
   * `polycap upload`: a token with the upload scope (POLYCAP_UPLOAD_TOKEN), itself or the name of one
   * saved with `polycap token new --save NAME`; the read token above cannot create uploads.
   */
  uploadToken?: string;
  /** What runs when a bundle is ready (docs/MAC.md H1): POLYCAP_HOOKS, else ~/.config/polycap/hooks.json. */
  hooksFile: string;
  maxUploadBytes: number;
  /** Hosted receiver storage: each upload token's default allowance, and the server-wide safety net. */
  allowanceBytes: number; storageHighBytes: number; storageLowBytes: number;
  /**
   * Hosted receiver, for people outside the team (thread-scoped tokens and signed-in testers who are not the team's):
   * a smaller allowance, and how many days their recordings keep their video before it is deleted with the bundle
   * left in place (docs/HOSTED.md, Storage; 2026-11-12). Unset, they get the default allowance and keep video until deleted.
   */
  memberAllowanceBytes?: number; memberVideoDays?: number;
  /** Hosted receiver: the largest 3D model a message may carry, and all of them together. */
  modelMaxBytes: number; modelsTotalBytes: number;
  /** Hosted receiver: the largest photo it keeps, and all of them together (docs/THREADS.md, Photos). */
  photoMaxBytes: number; photosTotalBytes: number;
}

/**
 * Names this tool had before it was renamed Polydance Capture on 2026-10-02. Finding one means a
 * setup that was not moved across; it is reported, never half-used, so nothing is silently ignored.
 */
export function legacySetup(env: NodeJS.ProcessEnv, home = homedir(), present: (path: string) => boolean = existsSync): string | undefined {
  const old = Object.keys(env).filter(key => key.startsWith('HINBOX_'));
  if (old.length) return `${old.join(', ')}: settings were renamed from HINBOX_* to POLYCAP_* on 2026-10-02; rename them where they are set`;
  if (!env.POLYCAP_CONFIG && !present(join(home, '.config', 'polycap', 'env')) && present(join(home, '.config', 'hinbox', 'env'))) {
    return 'the settings file moved: mv ~/.config/hinbox ~/.config/polycap, then rename HINBOX_ to POLYCAP_ in its env file';
  }
  if (!env.POLYCAP_ROOT && !present(join(home, 'PolydanceCapture')) && present(join(home, 'HeadsetInbox'))) {
    return 'the library moved: mv ~/HeadsetInbox ~/PolydanceCapture (or set POLYCAP_ROOT=~/HeadsetInbox)';
  }
  return undefined;
}

/** The per-user settings file. It can hold tokens, so it must be private. */
export const userConfigFile = (env: NodeJS.ProcessEnv = process.env) =>
  expandHome(env.POLYCAP_CONFIG || join(homedir(), '.config', 'polycap', 'env'));

/**
 * KEY=VALUE lines, # comments, optional quotes. The process environment wins over the file, so a
 * one-off `POLYCAP_ROOT=... polycap list` still works. A file readable by others is refused, not used.
 */
export function readEnvFile(path: string): Record<string, string> {
  let mode: number;
  try { mode = statSync(path).mode; } catch { return {}; }
  if (mode & 0o077) throw new Error(`${path} is readable by other users; run chmod 600 ${path}`);
  const values: Record<string, string> = {};
  readFileSync(path, 'utf8').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) throw new Error(`${path} line ${i + 1} is not KEY=VALUE`);
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  });
  return values;
}

/** A receiver's address: https, or http only on this machine or the local network, so a token never crosses the internet in the clear. */
export const remoteUrlAllowed = (url: string) => /^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url);

const expandHome = (path: string) => path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
function decimal(name: string, value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!/^\d*\.?\d+$/.test(value) || !Number.isFinite(n) || n <= min || n >= max) throw new Error(`${name}=${value} is not a number between ${min} and ${max}`);
  return n;
}
function integer(name: string, value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name}=${value} is not an integer between ${min} and ${max}`);
  return n;
}

/** Every setting has a safe default; the environment only overrides. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const root = resolve(expandHome(overrides.root ?? env.POLYCAP_ROOT ?? join(homedir(), 'PolydanceCapture')));
  const kind = env.POLYCAP_TRANSCRIBER ?? 'whisper-cpp';
  if (kind !== 'whisper-cpp' && kind !== 'gladia' && kind !== 'none') throw new Error(`POLYCAP_TRANSCRIBER=${kind} is not whisper-cpp, gladia or none`);
  if (kind === 'gladia' && !env.GLADIA_API_KEY) throw new Error('POLYCAP_TRANSCRIBER=gladia needs GLADIA_API_KEY');
  const summarizer = env.POLYCAP_SUMMARIZER || 'none';
  if (summarizer !== 'claude' && summarizer !== 'none') throw new Error(`POLYCAP_SUMMARIZER=${summarizer} is not claude or none`);
  if (summarizer === 'claude' && !env.ANTHROPIC_API_KEY) throw new Error('POLYCAP_SUMMARIZER=claude needs ANTHROPIC_API_KEY');
  const summaryModel = env.POLYCAP_SUMMARY_MODEL || 'claude-haiku-4-5';
  if (!/^claude-[a-z0-9-]+$/.test(summaryModel)) throw new Error(`POLYCAP_SUMMARY_MODEL=${summaryModel} is not a Claude model id`);
  const pointing = env.POLYCAP_POINTING || 'none';
  if (pointing !== 'claude' && pointing !== 'none') throw new Error(`POLYCAP_POINTING=${pointing} is not claude or none`);
  if (pointing === 'claude' && !env.ANTHROPIC_API_KEY) throw new Error('POLYCAP_POINTING=claude needs ANTHROPIC_API_KEY');
  const pointingModel = env.POLYCAP_POINTING_MODEL || 'claude-haiku-4-5';
  if (!/^claude-[a-z0-9-]+$/.test(pointingModel)) throw new Error(`POLYCAP_POINTING_MODEL=${pointingModel} is not a Claude model id`);
  const scenes = env.POLYCAP_SCENES || 'calls';
  if (scenes !== 'calls' && scenes !== 'all' && scenes !== 'none') throw new Error(`POLYCAP_SCENES=${scenes} is not calls, all or none`);
  const speakers = env.POLYCAP_SPEAKERS || 'meet';
  if (speakers !== 'meet' && speakers !== 'none') throw new Error(`POLYCAP_SPEAKERS=${speakers} is not meet or none`);
  const anthropicUrl = (env.POLYCAP_ANTHROPIC_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(anthropicUrl)) throw new Error(`POLYCAP_ANTHROPIC_URL=${anthropicUrl} must be https, or http on this machine`);
  const remoteUrl = env.POLYCAP_REMOTE_URL?.replace(/\/+$/, '') || undefined;
  if (remoteUrl && !remoteUrlAllowed(remoteUrl)) {
    throw new Error(`POLYCAP_REMOTE_URL=${remoteUrl} must be https, or http on this machine or the local network`);
  }
  const base: Config = {
    root, raw: join(root, 'raw'), sessions: join(root, 'sessions'), work: join(root, 'work'), logs: join(root, 'logs'), models: join(root, 'models'), ledgerFile: join(root, 'ledger.json'),
    uploads: join(root, 'uploads'), threadsDir: join(root, 'threads'), threadModels: join(root, 'thread-models'),
    threadPhotos: join(root, 'thread-photos'), photos: join(root, 'photos'),
    adb: env.POLYCAP_ADB || 'adb', ffmpeg: env.POLYCAP_FFMPEG || 'ffmpeg', ffprobe: env.POLYCAP_FFPROBE || 'ffprobe',
    transcriber: kind, whisperBin: env.POLYCAP_WHISPER_BIN || 'whisper-cli',
    whisperModel: expandHome(env.POLYCAP_WHISPER_MODEL || join(root, 'models', 'ggml-large-v3-turbo.bin')),
    language: env.POLYCAP_LANGUAGE || 'en', threads: integer('POLYCAP_THREADS', env.POLYCAP_THREADS, 0, 0, 64),
    gladiaKey: env.GLADIA_API_KEY || undefined, gladiaUrl: (env.POLYCAP_GLADIA_URL || 'https://api.gladia.io').replace(/\/+$/, ''),
    gladiaDeleteJobs: env.POLYCAP_GLADIA_KEEP_JOBS !== '1',
    summarizer, anthropicKey: env.ANTHROPIC_API_KEY || undefined, anthropicUrl, summaryModel, pointing, pointingModel,
    maxFrames: integer('POLYCAP_MAX_FRAMES', env.POLYCAP_MAX_FRAMES, 80, 2, 500),
    frameWidth: integer('POLYCAP_FRAME_WIDTH', env.POLYCAP_FRAME_WIDTH, 1024, 160, 4096),
    intervalMs: integer('POLYCAP_FRAME_INTERVAL_MS', env.POLYCAP_FRAME_INTERVAL_MS, 5000, 500, 600_000),
    scenes, sceneThreshold: decimal('POLYCAP_SCENE_THRESHOLD', env.POLYCAP_SCENE_THRESHOLD, 0.03, 0, 1),
    maxScenes: integer('POLYCAP_MAX_SCENES', env.POLYCAP_MAX_SCENES, 120, 1, 1000),
    // Where mac/build.sh puts it in the checkout polycap runs from, as install-skill finds the skill.
    speakers, speakersBin: resolve(expandHome(env.POLYCAP_SPEAKERS_BIN || join(dirname(fileURLToPath(import.meta.url)), '..', 'mac', 'build', 'polydance-speakers'))),
    stableMs: integer('POLYCAP_STABLE_MS', env.POLYCAP_STABLE_MS, 5000, 0, 120_000),
    minAgeMs: integer('POLYCAP_MIN_AGE_MS', env.POLYCAP_MIN_AGE_MS, 15_000, 0, 3_600_000),
    deviceFolders: env.POLYCAP_DEVICE_FOLDERS ? env.POLYCAP_DEVICE_FOLDERS.split(',').map(s => s.trim()).filter(Boolean) : null,
    remoteUrl, remoteToken: env.POLYCAP_REMOTE_TOKEN || undefined, uploadToken: env.POLYCAP_UPLOAD_TOKEN || undefined,
    hooksFile: resolve(expandHome(env.POLYCAP_HOOKS || join(homedir(), '.config', 'polycap', 'hooks.json'))),
    maxUploadBytes: integer('POLYCAP_MAX_UPLOAD_BYTES', env.POLYCAP_MAX_UPLOAD_BYTES, 4 * 1024 ** 3, 1024 ** 2, 64 * 1024 ** 3),
    allowanceBytes: integer('POLYCAP_ALLOWANCE_BYTES', env.POLYCAP_ALLOWANCE_BYTES, 8 * 1000 ** 3, 1, 10 * 1024 ** 4),
    storageHighBytes: integer('POLYCAP_STORAGE_HIGH_BYTES', env.POLYCAP_STORAGE_HIGH_BYTES, 13 * 1000 ** 3, 1, 10 * 1024 ** 4),
    storageLowBytes: integer('POLYCAP_STORAGE_LOW_BYTES', env.POLYCAP_STORAGE_LOW_BYTES, 11 * 1000 ** 3, 1, 10 * 1024 ** 4),
    memberAllowanceBytes: env.POLYCAP_MEMBER_ALLOWANCE_BYTES ? integer('POLYCAP_MEMBER_ALLOWANCE_BYTES', env.POLYCAP_MEMBER_ALLOWANCE_BYTES, 0, 1, 10 * 1024 ** 4) : undefined,
    memberVideoDays: env.POLYCAP_MEMBER_VIDEO_DAYS ? integer('POLYCAP_MEMBER_VIDEO_DAYS', env.POLYCAP_MEMBER_VIDEO_DAYS, 0, 1, 3650) : undefined,
    modelMaxBytes: integer('POLYCAP_MODEL_MAX_BYTES', env.POLYCAP_MODEL_MAX_BYTES, 50 * 1000 ** 2, 1024, MODEL_MAX_BYTES),
    modelsTotalBytes: integer('POLYCAP_MODELS_TOTAL_BYTES', env.POLYCAP_MODELS_TOTAL_BYTES, 2 * 1000 ** 3, 1, 10 * 1024 ** 4),
    photoMaxBytes: integer('POLYCAP_PHOTO_MAX_BYTES', env.POLYCAP_PHOTO_MAX_BYTES, PHOTO_MAX_BYTES, 1024, PHOTO_CEILING_BYTES),
    photosTotalBytes: integer('POLYCAP_PHOTOS_TOTAL_BYTES', env.POLYCAP_PHOTOS_TOTAL_BYTES, 2 * 1000 ** 3, 1, 10 * 1024 ** 4),
  };
  const { root: _ignored, ...rest } = overrides;
  const config = { ...base, ...rest };
  if (config.storageLowBytes >= config.storageHighBytes) throw new Error('POLYCAP_STORAGE_LOW_BYTES must be below POLYCAP_STORAGE_HIGH_BYTES');
  return config;
}

export async function ensureLayout(config: Config): Promise<void> {
  for (const dir of [config.root, config.raw, config.sessions, config.work, config.logs, config.models]) await privateDir(dir);
}
