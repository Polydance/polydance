/**
 * What a recorded call is, as the recording app reports it (docs/MAC.md T2): which app and meeting,
 * when it started and why it stopped, whether the screen and the far end were captured, and whether
 * the others were told. Also the marks pressed during any recording (C7). The schemas and the words for
 * them, with no other imports, so session.json, the import metadata and the pipeline share them. Names
 * and addresses of invitees are deliberately absent until there is a decision on where personal data
 * lives.
 */
import { z } from 'zod';

/** Call apps in the order Robin uses them (D1); only Meet in Arc is detected so far. */
export const CALL_APPS = ['meet', 'zoom', 'teams', 'slack', 'facetime'] as const;
export type CallApp = typeof CALL_APPS[number];
/** Browsers whose tabs can be read through Apple Events (D2); Firefox cannot be asked. */
export const CALL_BROWSERS = ['arc', 'chrome', 'safari', 'brave', 'edge'] as const;
/** Why a recording stopped (D4): the tab left the meeting, the browser let go of the mic, the user, the 4 h cap, or the app quitting. */
export const STOP_REASONS = ['left-call', 'mic-released', 'user', 'cap', 'app-quit'] as const;

const isoTime = z.iso.datetime({ offset: true, message: 'must be an ISO 8601 time such as 2026-11-05T11:00:02.120Z' });

/** A Meet meeting code as it appears in the tab's address: meet.google.com/abc-defg-hij. */
export const MEETING_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

/**
 * A stretch of a call without a picture (docs/MAC.md C14): the screen capture stopped at fromMs and came
 * back at toMs, on the recording's clock (from its first sample, as marks are); without toMs it never came
 * back. `reason` is what stopped it, in macOS's words where it gave any. The file shows black there.
 */
export const videoGapSchema = z.strictObject({
  fromMs: z.number().int().nonnegative(),
  toMs: z.number().int().nonnegative().optional(),
  reason: z.string().min(1).max(120),
}).refine(gap => gap.toMs === undefined || gap.toMs >= gap.fromMs, { message: 'toMs is before fromMs', path: ['toMs'] });
export type VideoGap = z.infer<typeof videoGapSchema>;
/** At most this many gaps in one call; the Mac app stops restarting long before. */
export const MAX_VIDEO_GAPS = 20;

export const callSchema = z.strictObject({
  app: z.enum(CALL_APPS),
  browser: z.enum(CALL_BROWSERS).optional(),
  meetingCode: z.string().regex(MEETING_CODE, 'must look like abc-defg-hij').optional(),
  startedAt: isoTime,
  /** Absent when the recording was cut off before the app could say. */
  endedAt: isoTime.optional(),
  stopReason: z.enum(STOP_REASONS).optional(),
  /** `none` when the screen was not recorded (permission refused or unanswered, C11): the recording is audio only. */
  video: z.enum(['recorded', 'none']).optional(),
  videoNote: z.string().min(1).max(300).optional(),
  /** `silent` when the tap delivered digital silence while the call app played sound (C12). */
  farEnd: z.enum(['heard', 'silent']).optional(),
  /** Under 2 minutes: most likely a lobby preview or a mic test (D5). */
  short: z.boolean().optional(),
  /** Cut off by a crash, sleep or full disk; everything up to then is in the file (C4). */
  cut: z.boolean().optional(),
  /** Whether the user told the others they were being recorded (PV2). */
  told: z.enum(['yes', 'no', 'unknown']).optional(),
  /** The size in points of what was captured, as the app saw it at the start: the call's window, else the display. */
  display: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  /** Bundle ids of the apps left out of the capture (C3). */
  excludedApps: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/, 'must be a bundle id')).max(200).optional(),
  /** Where the picture stopped mid-call and when it came back, in order (C14). */
  videoGaps: z.array(videoGapSchema).max(MAX_VIDEO_GAPS).optional(),
}).refine(call => !call.endedAt || Date.parse(call.endedAt) >= Date.parse(call.startedAt), { message: 'endedAt is before startedAt', path: ['endedAt'] });
export type SessionCall = z.infer<typeof callSchema>;

/** A moment the user marked with the shortcut, on the recording's clock, with an optional note. */
export const markSchema = z.strictObject({
  atMs: z.number().int().nonnegative(),
  note: z.string().max(200).optional(),
});
export type Mark = z.infer<typeof markSchema>;
/** At most this many marks in one recording; a stuck key must not flood the bundle. */
export const MAX_MARKS = 500;

/** How a person reads each app's name. */
export const CALL_APP_NAMES: Record<CallApp, string> = { meet: 'Google Meet', zoom: 'Zoom', teams: 'Microsoft Teams', slack: 'Slack huddle', facetime: 'FaceTime' };
const STOP_WORDS: Record<typeof STOP_REASONS[number], string> = {
  'left-call': 'left the call', 'mic-released': 'the browser released the microphone', user: 'stopped by hand', cap: 'reached the 4 h cap', 'app-quit': 'the app quit',
};
export const stopReasonText = (reason: SessionCall['stopReason']) => reason ? STOP_WORDS[reason] : 'not recorded';

/** Whether atMs falls where a call had no picture: from a gap's start up to (not including) its end. */
export const inVideoGap = (atMs: number, gaps: readonly Pick<VideoGap, 'fromMs' | 'toMs'>[] | undefined) =>
  (gaps ?? []).some(gap => atMs >= gap.fromMs && (gap.toMs === undefined || atMs < gap.toMs));

/** "Google Meet abc-defg-hij in arc". */
export const callTitle = (call: SessionCall) => `${CALL_APP_NAMES[call.app]}${call.meetingCode ? ` ${call.meetingCode}` : ''}${call.browser ? ` in ${call.browser}` : ''}`;

/** The call's own length from its start and end clocks, when both are known. */
export const callLengthMs = (call: SessionCall) => call.endedAt ? Date.parse(call.endedAt) - Date.parse(call.startedAt) : undefined;

/**
 * The tag `polycap export` writes into a call's video and audio (the format's comment), so a copy put
 * elsewhere with --out still says it is a call and `polycap upload` refuses it. ffmpeg keeps it when
 * the copy is re-encoded by ffmpeg again (checked with 8.0, 2026-11-05).
 */
export const CALL_TAG_PREFIX = 'polycap-call:';
export const callTag = (id: string) => `${CALL_TAG_PREFIX}${id}`;
