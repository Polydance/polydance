/**
 * The metadata a recording app hands `polycap import` beside the file (`--meta <file>.meta.json`, and
 * `--tracks mic,app`), docs/MAC.md T1 and T2. Version 1 is strict: an unknown field, a wrong value or
 * a conflict with the command line is refused with the field named, never guessed around. Every field
 * but `version` is optional; a walkthrough has no `call`. Its fields map onto session.json's source.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { callSchema, markSchema, MAX_MARKS, type Mark, type SessionCall } from './call.js';
import { UserError } from './errors.js';
import { AUDIO_ROLES, type AudioRole } from './session.js';

const noRepeats = (roles: readonly string[]) => new Set(roles).size === roles.length;

export const importMetaSchema = z.strictObject({
  version: z.literal(1),
  recordedAt: z.iso.datetime({ offset: true, message: 'must be an ISO 8601 time such as 2026-11-05T11:00:02.120Z' }).optional(),
  appPackage: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/, 'must be a package or bundle id such as net.polydance.capture.mac').max(200).optional(),
  appBuild: z.strictObject({
    versionName: z.string().min(1).max(80),
    versionCode: z.number().int().nonnegative().optional(),
    commit: z.string().regex(/^[0-9a-f]{7,40}(-dirty)?$/, 'must be a git commit hash').optional(),
  }).optional(),
  /** What each audio track is, in file order: the Mac app records the mic, then the call's sound. */
  audioTracks: z.array(z.enum(AUDIO_ROLES)).min(1).max(8).refine(noRepeats, 'names a track role twice').optional(),
  marks: z.array(markSchema).max(MAX_MARKS).optional(),
  call: callSchema.optional(),
});
export type ImportMeta = z.infer<typeof importMetaSchema>;

const issues = (error: z.ZodError) => error.issues.map(i => `${i.path.length ? i.path.join('.') : '(top level)'}: ${i.message}`).join('; ');

/** Parses metadata text; `where` names it in the error. */
export function parseImportMeta(text: string, where = 'the metadata'): ImportMeta {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (error) { throw new UserError(`${where} is not JSON: ${error instanceof Error ? error.message : String(error)}`); }
  const result = importMetaSchema.safeParse(raw);
  if (!result.success) throw new UserError(`${where} is not valid import metadata (version 1, docs/MAC.md T2): ${issues(result.error)}`);
  return result.data;
}

export async function readImportMeta(path: string): Promise<ImportMeta> {
  const text = await readFile(path, 'utf8').catch(() => { throw new UserError(`--meta ${path} does not exist or is not readable`); });
  return parseImportMeta(text, `--meta ${path}`);
}

/** `--tracks mic,app`: what each audio track is, in file order. */
export function parseTracks(value: string): AudioRole[] {
  const roles = value.split(',').map(s => s.trim());
  const bad = roles.filter(r => !(AUDIO_ROLES as readonly string[]).includes(r));
  if (!roles.length || bad.length) throw new UserError(`--tracks ${value}: each track is ${AUDIO_ROLES.join(' or ')}, comma separated, in file order (e.g. --tracks mic,app)`);
  if (!noRepeats(roles)) throw new UserError(`--tracks ${value} names a track role twice`);
  return roles as AudioRole[];
}

export interface ImportFlags { app?: string; recordedAt?: string; tracks?: string }

export interface ImportSource {
  appPackage?: string; recordedAt?: Date; recordedAtSource?: 'argument' | 'meta';
  appBuild?: ImportMeta['appBuild']; audioTracks?: AudioRole[]; call?: SessionCall; marks?: Mark[];
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The command line and the metadata together. Either may give the app, the time and the tracks; when
 * both do they must agree, because a recording described two ways is described wrongly once. Empty
 * notes on marks are dropped, and marks are kept in clock order.
 */
export function importSource(flags: ImportFlags, meta?: ImportMeta): ImportSource {
  const out: ImportSource = {};
  const app = flags.app ?? meta?.appPackage;
  if (flags.app && meta?.appPackage && flags.app !== meta.appPackage) throw new UserError(`--app ${flags.app} conflicts with appPackage ${meta.appPackage} in --meta`);
  if (app) out.appPackage = app;
  if (flags.recordedAt) {
    const at = new Date(flags.recordedAt);
    if (Number.isNaN(at.getTime())) throw new UserError(`--recorded-at ${flags.recordedAt} is not a date`);
    if (meta?.recordedAt && Date.parse(meta.recordedAt) !== at.getTime()) throw new UserError(`--recorded-at ${flags.recordedAt} conflicts with recordedAt ${meta.recordedAt} in --meta`);
    out.recordedAt = at; out.recordedAtSource = 'argument';
  } else if (meta?.recordedAt) { out.recordedAt = new Date(meta.recordedAt); out.recordedAtSource = 'meta'; }
  const tracks = flags.tracks !== undefined ? parseTracks(flags.tracks) : undefined;
  if (tracks && meta?.audioTracks && !sameList(tracks, meta.audioTracks)) throw new UserError(`--tracks ${flags.tracks} conflicts with audioTracks ${meta.audioTracks.join(',')} in --meta`);
  const audioTracks = tracks ?? meta?.audioTracks;
  if (audioTracks) out.audioTracks = [...audioTracks];
  if (meta?.appBuild) out.appBuild = meta.appBuild;
  if (meta?.call) out.call = meta.call;
  if (meta?.marks?.length) {
    out.marks = meta.marks
      .map(m => { const note = m.note?.replace(/\s+/g, ' ').trim(); return note ? { atMs: m.atMs, note } : { atMs: m.atMs }; })
      .sort((a, b) => a.atMs - b.atMs);
  }
  return out;
}
