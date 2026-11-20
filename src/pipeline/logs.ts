/**
 * The logs step: the headset's log for a take (logcat.txt, docs/LOGS.md) put on the take's clock. The
 * recording app sends what `logcat -v threadtime -v epoch -v uid -v printable` printed and nothing else; this is
 * the one place that reads it. A line's epoch time less the take's 0:00 (source.logs.zeroAt) is its clock.
 * Lines from before 0:00 or after the end are counted and left out; lines not in logcat's shape (its
 * "--------- beginning of main" banners, anything else) are counted, never guessed at. Writes logs.txt, every
 * line on the take's clock for a person or an agent to read and search, and logs.json, what is in them:
 * counts, where they start and end, which apps wrote them, and the errors.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { writeJsonAtomic } from '../fsx.js';
import type { LogsSource } from '../session.js';
import { pad } from '../time.js';

export const LEVELS = ['V', 'D', 'I', 'W', 'E', 'F'] as const;
export type Level = typeof LEVELS[number];

export interface LogLine {
  atMs: number; level: Level; tag: string; pid: number;
  /** The uid as logcat printed it (a number, or a short name such as root), and its package when the headset said. */
  uid?: string; app?: string;
  text: string;
}

/**
 * `1763290000.123 10123:  4321  4400 E chromium: text`: epoch seconds and a fraction, the uid and a colon
 * (with `-v uid`, when logcat may print it), pid, tid, level, the tag padded to eight, a colon and the text.
 */
const LINE = /^\s*(\d{1,12})\.(\d{1,9})\s+(?:([A-Za-z0-9_.]+):\s*)?(\d+)\s+(\d+)\s+([VDIWEF])\s(.*?)\s*:(?: (.*))?$/;

/** One line, or undefined when it is not in that shape. */
export function parseLine(raw: string, zeroAt: number, packages: Record<string, string> = {}): LogLine | undefined {
  const m = LINE.exec(raw);
  if (!m) return undefined;
  const atMs = Number(m[1]) * 1000 + Number(m[2].slice(0, 3).padEnd(3, '0')) - zeroAt;
  const uid = m[3];
  return {
    atMs, level: m[6] as Level, tag: m[7].trim(), pid: Number(m[4]),
    ...(uid ? { uid, ...(packages[uid] ? { app: packages[uid] } : {}) } : {}),
    text: m[8] ?? '',
  };
}

/** 01:02.345, or 1:01:02.345 past an hour: a log line's clock, to the millisecond, floored like formatClock. */
export function logClock(ms: number): string {
  const t = Math.max(0, Math.floor(ms));
  const h = Math.floor(t / 3_600_000), m = Math.floor((t % 3_600_000) / 60_000), s = Math.floor((t % 60_000) / 1000);
  const clock = `${pad(m)}:${pad(s)}.${pad(t % 1000, 3)}`;
  return h > 0 ? `${h}:${clock}` : clock;
}

/** A line as logs.txt and the storyboard write it. */
export const lineText = (line: LogLine) => `[${logClock(line.atMs)}] ${line.level} ${line.tag}${line.app ? ` (${line.app})` : line.uid ? ` (uid ${line.uid})` : ''}: ${line.text}`;

const MAX_ERRORS = 300, MAX_APPS = 30, MAX_TEXT = 500;
const errorSchema = z.strictObject({ atMs: z.number().int().nonnegative(), level: z.enum(['E', 'F']), tag: z.string(), app: z.string().optional(), uid: z.string().optional(), text: z.string() });
export const logsFileSchema = z.strictObject({
  version: z.literal(1),
  /** The whole device's lines, or the recording app's own; with the headset's note saying why when it is its own. */
  scope: z.enum(['device', 'app']), note: z.string().optional(), truncated: z.boolean().optional(),
  lines: z.number().int().nonnegative(),
  levels: z.record(z.enum(LEVELS), z.number().int().nonnegative()),
  firstAtMs: z.number().int().nonnegative().optional(), lastAtMs: z.number().int().nonnegative().optional(),
  /** Lines read but outside the take: before its 0:00, after its end; and lines not in logcat's shape. */
  before: z.number().int().nonnegative(), after: z.number().int().nonnegative(), unread: z.number().int().nonnegative(),
  /** Who wrote the lines, most first: the package when the headset named the uid, else the uid. */
  apps: z.array(z.strictObject({ app: z.string(), lines: z.number().int().positive() })).max(MAX_APPS),
  /** Errors and fatals, in order, the first MAX_ERRORS, each cut to MAX_TEXT characters; `errorCount` counts them all. */
  errors: z.array(errorSchema).max(MAX_ERRORS), errorCount: z.number().int().nonnegative(),
});
export type LogsFile = z.infer<typeof logsFileSchema>;

/** Reads logcat output onto the take's clock: the lines from 0:00 to the end, and what logs.json says about them. */
export function readLogs(text: string, source: LogsSource, durationMs: number): { lines: LogLine[]; file: LogsFile } {
  const lines: LogLine[] = [];
  let before = 0, after = 0, unread = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const line = parseLine(raw, source.zeroAt, source.packages);
    if (!line) { unread++; continue; }
    if (line.atMs < 0) before++;
    else if (line.atMs > durationMs) after++;
    else lines.push(line);
  }
  // logcat prints each buffer in time order, and several buffers merged; one order makes one clock.
  lines.sort((a, b) => a.atMs - b.atMs);
  const levels = Object.fromEntries(LEVELS.map(l => [l, 0])) as Record<Level, number>;
  const by = new Map<string, number>();
  for (const line of lines) {
    levels[line.level]++;
    const who = line.app ?? (line.uid ? `uid ${line.uid}` : undefined);
    if (who) by.set(who, (by.get(who) ?? 0) + 1);
  }
  const errors = lines.filter(l => l.level === 'E' || l.level === 'F');
  const file: LogsFile = {
    version: 1, scope: source.scope, ...(source.note ? { note: source.note } : {}), ...(source.truncated ? { truncated: true } : {}),
    lines: lines.length, levels,
    ...(lines.length ? { firstAtMs: Math.floor(lines[0].atMs), lastAtMs: Math.floor(lines.at(-1)!.atMs) } : {}),
    before, after, unread,
    apps: [...by].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_APPS).map(([app, n]) => ({ app, lines: n })),
    errors: errors.slice(0, MAX_ERRORS).map(e => ({
      atMs: Math.floor(e.atMs), level: e.level as 'E' | 'F', tag: e.tag, ...(e.app ? { app: e.app } : {}), ...(e.uid && !e.app ? { uid: e.uid } : {}), text: e.text.slice(0, MAX_TEXT),
    })),
    errorCount: errors.length,
  };
  return { lines, file: logsFileSchema.parse(file) };
}

/** A gap at the start worth saying: the first line comes this long after 0:00 in a take longer than that. */
const START_GAP_MS = 10_000;

/** What the lines are, in a sentence or two, for the step's note, logs.txt's head and the storyboard. */
export function logsAbout(file: LogsFile): string {
  const whose = file.scope === 'device' ? "The headset's log: every app's lines" : `Polydance's own lines only, not the other apps'${file.note ? ` (${file.note.replace(/\.$/, '')})` : ''}`;
  const parts = [`${whose}.`];
  if (file.firstAtMs !== undefined && file.firstAtMs > START_GAP_MS) parts.push(`Nothing before ${logClock(file.firstAtMs)}: the headset's log buffer may have dropped the start of the take.`);
  if (file.truncated) parts.push('The headset stopped reading at its limit, so the end of the take may be missing.');
  return parts.join(' ');
}

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;

/** The step's note: how many lines, from how many apps, how many errors, and anything left out. */
export function logsNote(file: LogsFile): string {
  const left = [file.before ? `${file.before} before 0:00` : '', file.after ? `${file.after} after the end` : '', file.unread ? `${file.unread} not in logcat's shape` : ''].filter(Boolean);
  return `${count(file.lines, 'line')}${file.apps.length ? ` from ${count(file.apps.length, 'app')}` : ''}, ${count(file.errorCount, 'error')}; ${file.scope === 'device' ? 'whole device' : "Polydance's own"}`
    + `${left.length ? `; left out: ${left.join(', ')}` : ''}${file.truncated ? '; cut at the headset\'s limit' : ''}`;
}

/** Reads logcat.txt and writes logs.txt and logs.json. */
export async function writeLogs(paths: { logcat: string; logsTxt: string; logsJson: string }, sessionId: string, source: LogsSource, durationMs: number): Promise<LogsFile> {
  const { lines, file } = readLogs(await readFile(paths.logcat, 'utf8'), source, durationMs);
  const head = [`# Logs: ${sessionId}`, `# ${logsAbout(file)}`, '# Each line on the take\'s clock (0:00 is when it began): level (V D I W E F), tag, the app that wrote it, then the text. logcat.txt is the file as the headset sent it.', ''];
  await writeFile(paths.logsTxt, `${[...head, ...lines.map(lineText)].join('\n')}\n`, { mode: 0o600 });
  await writeJsonAtomic(paths.logsJson, file);
  return file;
}
