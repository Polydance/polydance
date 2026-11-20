import { readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { z } from 'zod';
import { callSchema, markSchema, MAX_MARKS } from './call.js';
import type { Config } from './config.js';
import { UserError } from './errors.js';
import { appSlug, parseRecordingName } from './filename.js';
import { exists, linkOrCopy, privateDir, readJson, sha256File, writeJsonAtomic } from './fsx.js';
import { sessionThreadSchema } from './threads.js';
import { localStamp } from './time.js';
import { TOOL_NAME, TOOL_VERSION } from './version.js';

export const STEP_NAMES = ['probe', 'logs', 'audio', 'transcribe', 'speakers', 'frames', 'pointing', 'markers', 'summary', 'storyboard'] as const;
export type StepName = typeof STEP_NAMES[number];

const stepSchema = z.strictObject({
  status: z.enum(['pending', 'done', 'failed', 'skipped']),
  at: z.string().optional(), error: z.string().optional(), note: z.string().optional(),
});
/** One app coming to the front during a recording: clock from the recording's start, package, name, version. */
export const appSwitchSchema = z.strictObject({
  atMs: z.number().int().nonnegative(),
  package: z.string().regex(/^[A-Za-z0-9._]{1,200}$/),
  label: z.string().max(120).optional(),
  versionName: z.string().max(80).optional(),
  versionCode: z.number().int().nonnegative().optional(),
});
export type AppSwitch = z.infer<typeof appSwitchSchema>;
/** What Polydance opened from a thread's launch while recording, and when: which variant was on screen. */
export const openedSchema = z.strictObject({
  atMs: z.number().int().nonnegative(),
  /** The launch's steps in words, "open https://…" or "open app com.x (variant=b)". */
  what: z.string().min(1).max(300),
  label: z.string().max(40).optional(),
  /** The message it came from and, when that message offered options, which one (0-based) (2026-10-06). */
  message: z.number().int().positive().optional(),
  launch: z.number().int().nonnegative().max(5).optional(),
});
export type Opened = z.infer<typeof openedSchema>;

/** An opening as a person says it: "option 2: Red menu", "option 2", or its label alone; nothing for a plain launch. */
export const openedName = (o: Opened): string | undefined =>
  o.launch !== undefined ? `option ${o.launch + 1}${o.label ? `: ${o.label}` : ''}` : o.label;

/** What was on screen at a moment of the recording: the launch opened most recently at or before it. */
export const onScreen = (opened: readonly Opened[], atMs: number): Opened | undefined => opened.filter(o => o.atMs <= atMs).at(-1);

/**
 * The option on screen when something was said, worth saying only when the take covered more than one:
 * with one, every request would carry the same name (2026-10-06, CAP-1 #20 tagged all eight "option 2").
 */
export function optionAt(opened: readonly Opened[], atMs: number): string | undefined {
  if (new Set(opened.map(openedName).filter(Boolean)).size < 2) return undefined;
  const o = onScreen(opened, atMs);
  return o && openedName(o);
}
/** The headset's log for a take, as sent (docs/LOGS.md); at most 32 MiB. */
export const LOGS_FILE = 'logcat.txt';
export const MAX_LOGS = 32 * 1024 * 1024;
/**
 * What the recording app says about its log: the take's 0:00 on the headset's wall clock (ms), whether the
 * lines are the whole device's or the app's own, why when they are not, whether the file was cut at its
 * limit, and the package behind each uid in it.
 */
export const logsSourceSchema = z.strictObject({
  zeroAt: z.number().int().positive(),
  scope: z.enum(['device', 'app']),
  truncated: z.boolean().optional(),
  note: z.string().max(300).optional(),
  packages: z.record(z.string().regex(/^\d{1,10}$/), z.string().min(1).max(300))
    .refine(p => Object.keys(p).length <= 300, 'at most 300 packages').optional(),
});
export type LogsSource = z.infer<typeof logsSourceSchema>;
export const AUDIO_ROLES = ['mic', 'app'] as const;
export type AudioRole = typeof AUDIO_ROLES[number];
const sourceSchema = z.strictObject({
  kind: z.enum(['adb', 'import', 'upload']),
  /** Hosted receiver: the upload this session came from and the client's own id for the recording. */
  uploadId: z.string().optional(), clientId: z.string().optional(),
  serial: z.string().optional(), deviceProfile: z.string().optional(), deviceModel: z.string().optional(),
  remotePath: z.string().optional(), originalName: z.string(), originalPath: z.string().optional(),
  appPackage: z.string().optional(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** The build of appPackage that made the recording, when the transport knows it (Polydance sends its own). */
  appBuild: z.strictObject({ versionName: z.string(), versionCode: z.number().int().optional(), commit: z.string().optional() }).optional(),
  /** What each audio track is, in file order, when the transport knows (Polydance: mic, then app). */
  audioTracks: z.array(z.enum(AUDIO_ROLES)).optional(),
  /** Which app was in front from when, with its version, when the recording app could read the usage log. */
  apps: z.array(appSwitchSchema).optional(),
  /** The thread the recording is in, and the team's message and launch it answers (docs/THREADS.md). */
  thread: sessionThreadSchema.optional(),
  /** Each launch the app opened during the recording, with its clock (2026-10-04: variants within one take). */
  opened: z.array(openedSchema).optional(),
  /** The call this recording is, from the Mac app's metadata (2026-11-05, docs/MAC.md T2); absent for a walkthrough. */
  call: callSchema.optional(),
  /** Moments the user marked with the shortcut while recording (C7), on the recording's clock. */
  marks: z.array(markSchema).max(MAX_MARKS).optional(),
  /** The headset's log for the take, when it sent one (docs/LOGS.md). */
  logs: logsSourceSchema.optional(),
});
/**
 * Whose voice the transcript is: the narrator's microphone, the app's own sound when no microphone was
 * recorded (its voice-over is then not the user's words), unknown when there is one mixed track, or
 * both for a call, whose mic (Me) and call sound (Others) are transcribed apart and merged (2026-11-05).
 */
export const VOICES = ['mic', 'app', 'unknown', 'both'] as const;
export type Voice = typeof VOICES[number];
const mediaSchema = z.strictObject({
  /**
   * The take's media file: a video, or sound alone (an .m4a) when the screen was not recorded. Absent for a
   * take of logs alone (docs/LOGS.md), whose length the recording app said.
   */
  video: z.string().optional(), durationMs: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
  hasAudio: z.boolean().optional(), container: z.string().optional(),
  /** False when the file has no video stream (a call whose screen was not recorded); absent in bundles made before 2026-11-05. */
  hasVideo: z.boolean().optional(),
  /**
   * When the picture's last frame is, in ms, which for a Mac recording is often before the sound ends
   * (probe.ts probeVideoEnd); frames are planned up to it. Absent without video and in older bundles.
   */
  videoEndMs: z.number().int().nonnegative().optional(),
  /** Channels of each audio track in file order, from the probe; with source.audioTracks it says which is which. */
  audioChannels: z.array(z.number().int().positive()).optional(),
  /** Set by the audio step: whose voice the transcript is (see VOICES). */
  voice: z.enum(VOICES).optional(),
  /** The narration track alone, sent ahead of the video by the recording app so the words are ready first. */
  narration: z.literal('narration.m4a').optional(),
  /** The headset's log for the take, as sent; the logs step reads it into logs.txt and logs.json. */
  logs: z.literal(LOGS_FILE).optional(),
});
/** Claude's label for a recording: a few words, one sentence, and the model that wrote them. */
export const summarySchema = z.strictObject({ title: z.string().min(1), text: z.string().min(1), model: z.string() });
export type SessionSummary = z.infer<typeof summarySchema>;
/** requests.json: what the narrator asked for, each pinned to the transcript line it was said on. Claude's reading, not a record. */
/** change: something to be different; problem: something wrong; idea: a tentative suggestion; question: something to answer. */
export const REQUEST_KINDS = ['change', 'problem', 'idea', 'question'] as const;
const requestV1 = z.strictObject({ atMs: z.number().int().nonnegative(), text: z.string().min(1) });
/**
 * Version 2 (2026-10-12): each request also carries its kind and the words it rests on, checked
 * against the transcript line its clock pins it to. A request whose quote is on no line, or on
 * several, is kept in `rejected` with the reason instead of failing the whole summary step.
 */
const requestV2 = requestV1.extend({ kind: z.enum(REQUEST_KINDS), quote: z.string().min(1) });
/** As the model gave it, so its kind may be any string; the reason says what failed. */
const rejectedRequest = z.strictObject({ line: z.number(), quote: z.string(), kind: z.string(), text: z.string(), reason: z.string().min(1) });
export const requestsFileSchema = z.discriminatedUnion('version', [
  z.strictObject({ version: z.literal(1), model: z.string(), requests: z.array(requestV1) }),
  z.strictObject({ version: z.literal(2), model: z.string(), requests: z.array(requestV2), rejected: z.array(rejectedRequest) }),
]);
export type SessionRequest = z.infer<typeof requestV1> & Partial<Pick<z.infer<typeof requestV2>, 'kind' | 'quote'>>;
export type GroundedRequest = z.infer<typeof requestV2>;
export type RejectedRequest = z.infer<typeof rejectedRequest>;
export const sessionSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().min(1), title: z.string().min(1),
  createdAt: z.string(), recordedAt: z.string(), recordedAtSource: z.enum(['filename', 'mtime', 'argument', 'meta']),
  source: sourceSchema, media: mediaSchema,
  steps: z.strictObject({
    probe: stepSchema,
    logs: stepSchema.default({ status: 'skipped', note: 'made before logs existed' }),
    audio: stepSchema, transcribe: stepSchema,
    // Who of the Others spoke, from Meet's speaking ring (2026-11-11); `process --step speakers` adds it to an older call.
    speakers: stepSchema.default({ status: 'skipped', note: 'made before speaker names existed' }),
    frames: stepSchema,
    pointing: stepSchema.default({ status: 'skipped', note: 'made before pointing existed' }),
    markers: stepSchema,
    // Bundles made before these steps existed are complete as they are; `process --step <name>` adds them.
    summary: stepSchema.default({ status: 'skipped', note: 'made before summaries existed' }),
    storyboard: stepSchema.default({ status: 'skipped', note: 'made before storyboards existed' }),
  }),
  /** Claude's label for the recording; the title is also copied to `title` above. */
  summary: summarySchema.optional(),
  transcriber: z.strictObject({ kind: z.string(), model: z.string().optional(), language: z.string().optional() }).optional(),
  frameCount: z.number().int().nonnegative().optional(), markerCount: z.number().int().nonnegative().optional(),
  // Bundles made before the rename to Polydance Capture (2026-10-02) say headset-inbox.
  tool: z.strictObject({ name: z.union([z.literal(TOOL_NAME), z.literal('headset-inbox')]), version: z.string() }),
});
export type SessionManifest = z.infer<typeof sessionSchema>;
export type StepStatus = z.infer<typeof stepSchema>;
export type SessionSource = z.infer<typeof sourceSchema>;

export const SESSION_FILE = 'session.json';
export const sessionDir = (config: Config, id: string) => join(config.sessions, id);
export const sessionPaths = (dir: string) => ({
  manifest: join(dir, SESSION_FILE), transcriptJson: join(dir, 'transcript.json'), transcriptMd: join(dir, 'transcript.md'),
  markers: join(dir, 'markers.json'), frames: join(dir, 'frames'), framesJson: join(dir, 'frames.json'), contactSheet: join(dir, 'contact-sheet.jpg'),
  requests: join(dir, 'requests.json'), storyboard: join(dir, 'storyboard.md'), pointing: join(dir, 'pointing.json'), speakers: join(dir, 'speakers.json'),
  logcat: join(dir, LOGS_FILE), logsTxt: join(dir, 'logs.txt'), logsJson: join(dir, 'logs.json'),
});

export const NARRATION_FILE = 'narration.m4a';

export interface CreateSessionInput {
  /**
   * Local file to bundle. Hard-linked into the session when possible, never moved. Absent when only the
   * narration has arrived: the video joins the session later, under the name the manifest gives it.
   */
  localFile?: string; originalName: string;
  /** The narration track alone, ahead of the video; linked in as narration.m4a. */
  narrationFile?: string;
  /** The headset's log for the take; linked in as logcat.txt. With neither file nor narration, the take is its logs alone. */
  logsFile?: string;
  /** The take's length, for a take of logs alone: there is no file to probe. */
  durationMs?: number;
  source: Omit<SessionSource, 'bytes' | 'sha256' | 'originalName' | 'appPackage'> & { appPackage?: string };
  bytes: number; sha256?: string; mtimeMs?: number; recordedAt?: Date;
  /** Where recordedAt came from when given: the --recorded-at argument (default) or the import metadata. */
  recordedAtSource?: 'argument' | 'meta';
}

const pendingSteps = () => Object.fromEntries(STEP_NAMES.map(name => [name, { status: 'pending' as const }])) as SessionManifest['steps'];

/**
 * Creates sessions/<id>/ with the video (or its narration first), and its logs, and a manifest whose steps are
 * all pending. A take of logs alone has no video: the logs file is its original, and it says its own length.
 */
export async function createSession(config: Config, input: CreateSessionInput): Promise<{ dir: string; manifest: SessionManifest }> {
  const logsOnly = !input.localFile && !input.narrationFile;
  if (logsOnly && !(input.logsFile && input.durationMs)) throw new Error('a session needs its video, its narration and the video\'s sha256, or its logs and the take\'s length');
  if (!logsOnly && !input.localFile && !input.sha256) throw new Error('a session needs its video, or its narration and the video\'s sha256');
  const parsed = parseRecordingName(input.originalName);
  const appPackage = input.source.appPackage ?? parsed.appPackage;
  let recordedAt: Date; let recordedAtSource: SessionManifest['recordedAtSource'];
  if (input.recordedAt) { recordedAt = input.recordedAt; recordedAtSource = input.recordedAtSource ?? 'argument'; }
  else if (parsed.recordedAt) { recordedAt = parsed.recordedAt; recordedAtSource = 'filename'; }
  else { recordedAt = new Date(input.mtimeMs ?? Date.now()); recordedAtSource = 'mtime'; }
  // A call is named for its app ("_meet"), not the recorder's package, so a list of sessions says which are calls.
  const base = `${localStamp(recordedAt)}_${input.source.call ? input.source.call.app : appSlug(appPackage)}`;
  await privateDir(config.sessions);
  let id = base; for (let n = 2; await exists(sessionDir(config, id)); n++) id = `${base}-${n}`;
  const dir = sessionDir(config, id);
  await privateDir(dir);
  const ext = extname(input.originalName).toLowerCase().replace(/[^a-z0-9.]/g, '') || '.mp4';
  const video = logsOnly ? undefined : `video${ext}`;
  if (input.localFile) await linkOrCopy(input.localFile, join(dir, video!));
  if (input.narrationFile) await linkOrCopy(input.narrationFile, join(dir, NARRATION_FILE));
  if (input.logsFile) await linkOrCopy(input.logsFile, join(dir, LOGS_FILE));
  const original = input.localFile ?? (logsOnly ? input.logsFile : undefined);
  const manifest: SessionManifest = {
    version: 1, id, title: id, createdAt: new Date().toISOString(), recordedAt: recordedAt.toISOString(), recordedAtSource,
    source: { ...input.source, originalName: input.originalName, appPackage, bytes: input.bytes, sha256: input.sha256 ?? await sha256File(original!) },
    media: {
      ...(video ? { video } : {}), ...(logsOnly ? { durationMs: input.durationMs } : {}),
      ...(input.narrationFile ? { narration: NARRATION_FILE } : {}), ...(input.logsFile ? { logs: LOGS_FILE } : {}),
    },
    steps: pendingSteps(), tool: { name: TOOL_NAME, version: TOOL_VERSION },
  };
  await saveSession(dir, manifest);
  return { dir, manifest };
}

export const loadSession = (dir: string) => readJson(join(dir, SESSION_FILE), sessionSchema);
export const saveSession = (dir: string, manifest: SessionManifest) => writeJsonAtomic(join(dir, SESSION_FILE), sessionSchema.parse(manifest));

export interface SessionRef { dir: string; manifest: SessionManifest }

/** Newest first. Folders without a readable manifest are reported, not thrown, so one bad bundle cannot hide the rest. */
export async function listSessions(config: Config, warn: (line: string) => void = () => {}): Promise<SessionRef[]> {
  if (!await exists(config.sessions)) return [];
  const refs: SessionRef[] = [];
  for (const name of await readdir(config.sessions)) {
    const dir = join(config.sessions, name);
    if (!await exists(join(dir, SESSION_FILE))) continue;
    try { refs.push({ dir, manifest: await loadSession(dir) }); }
    catch (error) { warn(`Skipping ${basename(dir)}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return refs.sort((a, b) => b.manifest.recordedAt.localeCompare(a.manifest.recordedAt) || b.manifest.id.localeCompare(a.manifest.id));
}

/** A whole session id as createSession makes it: the local stamp, then the app or call, then -N for a second one that second. */
export const SESSION_ID_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}_[A-Za-z0-9._-]+$/;

/**
 * "latest", an exact id, or a unique prefix or substring of one. A ref shaped like a whole id is
 * taken as exactly that session: the Mac app passes exact ids, and when that session is gone or its
 * session.json does not read, a fuzzy match would act on another one (a "_meet-2" for a "_meet").
 */
export async function resolveSession(config: Config, ref: string): Promise<SessionRef> {
  const sessions = await listSessions(config);
  if (!sessions.length) throw new UserError('No sessions yet. Run `polycap pull` or `polycap import <video>`.');
  if (ref === 'latest') return sessions[0];
  const exact = sessions.find(s => s.manifest.id === ref);
  if (exact) return exact;
  if (SESSION_ID_SHAPE.test(ref)) throw new UserError(`No session ${ref}. Run \`polycap list\`.`);
  const matches = sessions.filter(s => s.manifest.id.startsWith(ref) || s.manifest.id.includes(ref) || s.manifest.title.toLowerCase().includes(ref.toLowerCase()));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new UserError(`No session matches "${ref}". Run \`polycap list\`.`);
  throw new UserError(`"${ref}" matches ${matches.length} sessions: ${matches.slice(0, 5).map(m => m.manifest.id).join(', ')}`);
}

/** A recorded call (source.call), as opposed to a walkthrough or a headset recording. */
export const isCall = (manifest: Pick<SessionManifest, 'source'>) => manifest.source.call !== undefined;

/**
 * Why a finished recording has no picture, or undefined when it has one: the recording app said the
 * screen was not recorded (C11), or the file has no video stream. Unlike words first, where the video
 * is still on its way, nothing more is coming, so frames are skipped rather than left pending.
 */
export function screenMissing(manifest: Pick<SessionManifest, 'source' | 'media'>): string | undefined {
  if (logsOnly(manifest)) return 'the take recorded logs alone';
  const call = manifest.source.call;
  if (call?.video === 'none') return `the screen was not recorded${call.videoNote ? ` (${call.videoNote})` : ''}`;
  if (manifest.media.hasVideo === false) return call?.video === 'recorded' ? 'the file has no video stream, though the recording app said the screen was recorded' : 'the file has no video stream: the screen was not recorded';
  return undefined;
}

/** A take of logs alone (docs/LOGS.md): no picture, no sound, nothing more coming. */
export const logsOnly = (manifest: Pick<SessionManifest, 'media'>) => manifest.media.video === undefined;

export const isPending = (manifest: SessionManifest) => STEP_NAMES.some(name => manifest.steps[name].status === 'pending');

/**
 * Words first: the narration has been transcribed, marked and summarised and a storyboard written
 * without frames, while the video has not yet arrived to be probed and cut into frames.
 */
export const wordsOnly = (manifest: SessionManifest) =>
  manifest.media.narration !== undefined && manifest.steps.probe.status === 'pending' && manifest.steps.storyboard.status !== 'pending';

/** A label for a build: "0.3.0 (3) d295600". */
export const buildLabel = (build: NonNullable<SessionSource['appBuild']>) => `${build.versionName}${build.versionCode !== undefined ? ` (${build.versionCode})` : ''}${build.commit ? ` ${build.commit}` : ''}`;

/**
 * The session this one follows: in a thread, the recording before it in that thread, whenever it was
 * made (2026-10-04: the same-app rule picked another app's recording for an inbox one); for a call, the
 * last call with the same meeting code (2026-11-05); otherwise the session made just before it with
 * the same app on the same headset, within a week. In a series of
 * design passes, the one whose requests this one should have been answering.
 */
export function previousSession(sessions: readonly SessionRef[], manifest: SessionManifest): SessionRef | undefined {
  const at = Date.parse(manifest.recordedAt);
  const thread = manifest.source.thread?.key;
  const before = (s: SessionRef) => s.manifest.id !== manifest.id && Date.parse(s.manifest.recordedAt) < at;
  const latest = (list: SessionRef[]) => list.sort((a, b) => b.manifest.recordedAt.localeCompare(a.manifest.recordedAt))[0];
  if (thread) return latest(sessions.filter(s => before(s) && s.manifest.source.thread?.key === thread));
  // A call follows the last call with the same meeting code, which a recurring Meet keeps (P9); a
  // call without one has no series to follow, and a call is never the session a walkthrough follows.
  const call = manifest.source.call;
  if (call) return call.meetingCode ? latest(sessions.filter(s => before(s) && s.manifest.source.call?.app === call.app && s.manifest.source.call.meetingCode === call.meetingCode)) : undefined;
  return sessions
    .filter(s => s.manifest.id !== manifest.id && !s.manifest.source.thread && !s.manifest.source.call && s.manifest.source.appPackage === manifest.source.appPackage && s.manifest.source.deviceModel === manifest.source.deviceModel)
    .filter(s => { const t = Date.parse(s.manifest.recordedAt); return t < at && at - t <= 7 * 86_400_000; })
    .sort((a, b) => b.manifest.recordedAt.localeCompare(a.manifest.recordedAt))[0];
}
