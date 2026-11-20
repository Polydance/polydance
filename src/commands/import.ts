import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { UserError } from '../errors.js';
import { ensureLayout } from '../config.js';
import { importSource, readImportMeta } from '../import-meta.js';
import { createSession, type SessionRef } from '../session.js';
import type { Cli } from './context.js';

/** `--meta` is the recording app's description of the file (docs/MAC.md T1); `--tracks mic,app` says which audio track is which. */
export interface ImportOptions { app?: string; recordedAt?: string; meta?: string; tracks?: string }

/** Turns any local video into a session. This is the receiver every transport ends at. */
export async function importRecording(cli: Cli, file: string, options: ImportOptions = {}): Promise<SessionRef> {
  const path = resolve(file);
  const info = await stat(path).catch(() => { throw new UserError(`${file} does not exist or is not readable`); });
  if (!info.isFile()) throw new UserError(`${file} is not a file`);
  // Everything is checked before anything is written, so a bad description leaves no half-made session.
  const meta = options.meta ? await readImportMeta(resolve(options.meta)) : undefined;
  const { recordedAt, recordedAtSource, ...source } = importSource({ app: options.app, recordedAt: options.recordedAt, tracks: options.tracks }, meta);
  await ensureLayout(cli.config);
  const session = await createSession(cli.config, {
    localFile: path, originalName: basename(path), bytes: info.size, mtimeMs: info.mtimeMs, recordedAt, recordedAtSource,
    source: { kind: 'import', originalPath: path, ...source },
  });
  cli.print(cli.json ? JSON.stringify({ id: session.manifest.id, dir: session.dir }) : `imported ${session.manifest.id} -> ${session.dir}`);
  return session;
}
