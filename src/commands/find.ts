/**
 * Finding recordings and calls in the library (Robin, 2026-11-12: agents need "a complete set of tools
 * for finding calls and polydance recordings"): the filters `polycap list` and `polycap search` share,
 * the people a call's bundle names, and the search over transcript lines. It reads this machine's
 * library only; hosted bundles are here once `polycap sync` has brought them down, and calls never
 * leave the Mac they were recorded on. Names are the other people's, so they are printed to whoever
 * runs polycap here and never written anywhere else.
 */
import { callLengthMs, callTitle, MEETING_CODE } from '../call.js';
import { UserError } from '../errors.js';
import { exists, readJson } from '../fsx.js';
import { speakersFileSchema } from '../pipeline/speakers.js';
import { transcriptFileSchema, type TranscriptFile } from '../pipeline/transcribe.js';
import { lineLabel } from '../pipeline/voices.js';
import { listSessions, sessionPaths, type SessionRef } from '../session.js';
import { formatClock } from '../time.js';
import type { Cli } from './context.js';
import { table } from './context.js';

export interface FindOptions {
  calls?: boolean; walkthroughs?: boolean;
  /** A day (2026-11-11, today, yesterday: this Mac's calendar day) or an ISO time; both ends included. */
  since?: string; until?: string;
  /** A call's meeting code: the same code is the same recurring meeting. */
  meeting?: string;
  /** Someone a call's bundle names (Meet's speaking ring), any part of the name, any case. */
  with?: string;
  /** Recordings in this thread (MUS-12). */
  thread?: string;
  /** The newest N that match. */
  limit?: string;
  /** For tests: the moment "today" is measured from. */
  now?: Date;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The first or last millisecond of a day on this machine's calendar, or the instant an ISO time names. */
export function timeBound(text: string, end: boolean, now = new Date()): number {
  const word = text.trim().toLowerCase();
  const day = word === 'today' ? new Date(now.getFullYear(), now.getMonth(), now.getDate())
    : word === 'yesterday' ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
    : DAY.test(word) ? (() => { const [, y, m, d] = DAY.exec(word)!.map(Number); const date = new Date(y, m - 1, d); return date.getMonth() === m - 1 && date.getDate() === d ? date : undefined; })()
    : undefined;
  if (day) return end ? new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime() - 1 : day.getTime();
  if (/^\d{4}-\d{2}-\d{2}T/.test(text) && Number.isFinite(Date.parse(text))) return Date.parse(text);
  throw new UserError(`"${text}" is not a day or a time: use 2026-11-11, today, yesterday or an ISO time such as 2026-11-11T13:00:00Z`);
}

/** Who a call's bundle names: the people Meet's speaking ring was seen on, and the names on Others' lines. */
export async function callPeople(ref: SessionRef, warn: (line: string) => void): Promise<string[]> {
  if (!ref.manifest.source.call) return [];
  const paths = sessionPaths(ref.dir);
  const names = new Set<string>();
  try {
    if (await exists(paths.speakers)) for (const person of (await readJson(paths.speakers, speakersFileSchema)).people) names.add(person.name);
    for (const segment of (await readTranscript(ref))?.segments ?? []) if (segment.name) names.add(segment.name);
  } catch (error) { warn(`${ref.manifest.id}: ${error instanceof Error ? error.message : String(error)}`); }
  return [...names];
}

const readTranscript = async (ref: SessionRef): Promise<TranscriptFile | undefined> => {
  const file = sessionPaths(ref.dir).transcriptJson;
  return await exists(file) ? readJson(file, transcriptFileSchema) : undefined;
};

export interface Found extends SessionRef { people: string[] }

/** The library's sessions that pass every filter given, newest first. */
export async function findSessions(cli: Cli, options: FindOptions = {}): Promise<Found[]> {
  if (options.calls && options.walkthroughs) throw new UserError('--calls and --walkthroughs together match everything: give one or neither');
  if (options.meeting && !MEETING_CODE.test(options.meeting.toLowerCase())) throw new UserError(`--meeting ${options.meeting}: a Meet code looks like abc-defg-hij`);
  const limit = options.limit === undefined ? undefined : Number(options.limit);
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new UserError(`--limit ${options.limit}: a whole number above 0`);
  const since = options.since ? timeBound(options.since, false, options.now) : undefined;
  const until = options.until ? timeBound(options.until, true, options.now) : undefined;
  const thread = options.thread?.toUpperCase(), meeting = options.meeting?.toLowerCase(), person = options.with?.trim().toLowerCase();
  const found: Found[] = [];
  for (const ref of await listSessions(cli.config, cli.warn)) {
    const { manifest } = ref, call = manifest.source.call, at = Date.parse(manifest.recordedAt);
    if (options.calls && !call) continue;
    if (options.walkthroughs && call) continue;
    if (since !== undefined && at < since) continue;
    if (until !== undefined && at > until) continue;
    if (meeting && call?.meetingCode !== meeting) continue;
    if (thread && manifest.source.thread?.key.toUpperCase() !== thread) continue;
    const people = await callPeople(ref, cli.warn);
    if (person && !people.some(name => name.toLowerCase().includes(person))) continue;
    found.push({ ...ref, people });
    if (limit !== undefined && found.length >= limit) break;
  }
  return found;
}

/** A session in `polycap list --json` and `search --json`: the manifest's facts an agent finds things by. */
export const foundJson = (s: Found) => {
  const { manifest } = s, call = manifest.source.call;
  return {
    id: manifest.id, kind: call ? 'call' : 'walkthrough', title: manifest.title, summary: manifest.summary?.text, recordedAt: manifest.recordedAt,
    durationMs: manifest.media.durationMs, appPackage: manifest.source.appPackage, device: manifest.source.deviceModel, dir: s.dir,
    ...(call ? { call: { app: call.app, meetingCode: call.meetingCode, startedAt: call.startedAt, endedAt: call.endedAt, video: call.video ?? 'recorded', short: call.short ?? false, told: call.told ?? 'unknown', people: s.people } } : {}),
    ...(manifest.source.thread ? { thread: { key: manifest.source.thread.key, title: manifest.source.thread.title } } : {}),
    steps: manifest.steps, frameCount: manifest.frameCount, markerCount: manifest.markerCount,
  };
};

/** `polycap list --calls`: what tells one call from another. */
export function callsTable(found: readonly Found[]): string {
  return table(found.map(s => {
    const call = s.manifest.source.call!, length = callLengthMs(call) ?? s.manifest.media.durationMs;
    return [s.manifest.id, s.manifest.summary?.title ?? '', length !== undefined ? formatClock(length) : '?', callTitle(call), s.people.join(', ') || '(no names)'];
  }), ['id', 'title', 'length', 'call', 'people (from Meet)']);
}

const fold = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

/** Every word, in any order, on one transcript line or in the title and summary; any case and accent. */
export const matchesAll = (text: string, words: readonly string[]) => { const folded = fold(text); return words.every(w => folded.includes(w)); };

export interface SearchHit { atMs: number; endMs: number; speaker?: string; text: string }

/** Lines printed per session; `polycap transcript <id> --from` shows the rest, and --json has them all. */
export const SEARCH_LINES = 10;

/** `polycap search`: the transcript lines, titles and summaries that hold every word, in the sessions the filters pass. */
export async function search(cli: Cli, query: readonly string[], options: FindOptions = {}): Promise<{ session: Found; titleHit: boolean; hits: SearchHit[] }[]> {
  const words = query.flatMap(q => fold(q).split(/\s+/)).filter(Boolean);
  if (!words.length) throw new UserError('search needs words to look for, e.g. polycap search typeface --calls --since yesterday');
  const results: { session: Found; titleHit: boolean; hits: SearchHit[] }[] = [];
  // The limit counts sessions with a match, not sessions looked at.
  const { limit, ...filters } = options;
  const max = limit === undefined ? undefined : Number(limit);
  if (max !== undefined && !(Number.isInteger(max) && max > 0)) throw new UserError(`--limit ${limit}: a whole number above 0`);
  for (const session of await findSessions(cli, filters)) {
    const { manifest } = session;
    const titleHit = matchesAll(`${manifest.title}\n${manifest.summary?.title ?? ''}\n${manifest.summary?.text ?? ''}`, words);
    let transcript: TranscriptFile | undefined;
    try { transcript = await readTranscript(session); } catch (error) { cli.warn(`${manifest.id}: ${error instanceof Error ? error.message : String(error)}`); }
    const hits = (transcript?.segments ?? []).filter(s => matchesAll(s.text, words)).map(s => ({ atMs: s.startMs, endMs: s.endMs, ...(lineLabel(s) ? { speaker: lineLabel(s) } : {}), text: s.text }));
    if (!titleHit && !hits.length) continue;
    results.push({ session, titleHit, hits });
    if (max !== undefined && results.length >= max) break;
  }
  if (cli.json) {
    cli.print(JSON.stringify(results.map(r => ({ ...foundJson(r.session), titleMatch: r.titleHit, matches: r.hits })), null, 2));
    return results;
  }
  if (!results.length) { cli.print(`Nothing in ${options.calls ? 'the calls' : options.walkthroughs ? 'the walkthroughs' : 'the library'} says "${query.join(' ')}"${filters.since || filters.until || filters.meeting || filters.with || filters.thread ? ' with those filters' : ''}. Run \`polycap sync\` first for hosted recordings.`); return results; }
  for (const { session, titleHit, hits } of results) {
    const { manifest } = session, call = manifest.source.call;
    const length = (call && callLengthMs(call)) ?? manifest.media.durationMs;
    cli.print(`${manifest.id}  ${manifest.summary?.title ?? manifest.title}  (${call ? `call${session.people.length ? ` with ${session.people.join(', ')}` : ''}` : 'walkthrough'}${length !== undefined ? `, ${formatClock(length)}` : ''})`);
    if (titleHit) cli.print('  in the title or summary');
    for (const hit of hits.slice(0, SEARCH_LINES)) cli.print(`  [${formatClock(hit.atMs)}]${hit.speaker ? ` ${hit.speaker}:` : ''} ${hit.text}`);
    if (hits.length > SEARCH_LINES) cli.print(`  ... ${hits.length - SEARCH_LINES} more lines: polycap search ... --json, or polycap transcript ${manifest.id} --from ${formatClock(hits[SEARCH_LINES].atMs)}`);
  }
  return results;
}
