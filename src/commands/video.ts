/**
 * One session's original recording, on this machine: the bundle's own video when it was pulled or
 * imported, otherwise downloaded from the hosted receiver into the session folder and checked against
 * the receiver's sha256, as `sync --video` does for every session. `export` and agents start from it;
 * `sync` never removes a downloaded video.
 */
import { createWriteStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import { z } from 'zod';
import { UserError } from '../errors.js';
import { exists, privateDir, sha256File } from '../fsx.js';
import { resolveSession, type SessionRef } from '../session.js';
import type { Cli } from './context.js';

const filesSchema = z.object({
  files: z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })),
});

export async function ensureVideo(cli: Cli, session: SessionRef): Promise<string> {
  const { manifest, dir } = session;
  const name = manifest.media.video;
  if (!name) throw new UserError(`${manifest.id} is a take of logs alone: it has no video (its logs are ${join(dir, 'logs.txt')})`);
  const path = join(dir, name);
  if (await exists(path)) return path;
  const { remoteUrl, remoteToken } = cli.config;
  if (manifest.source.kind !== 'upload') throw new UserError(`${manifest.id} has no video here (${path} is missing)`);
  if (!remoteUrl || !remoteToken) throw new UserError(`${manifest.id}'s video is on the receiver; set POLYCAP_REMOTE_URL and POLYCAP_REMOTE_TOKEN to fetch it`);
  const base = `${remoteUrl}/v1/sessions/${encodeURIComponent(manifest.id)}`;
  const get = async (url: string) => {
    const response = await fetch(url, { headers: { authorization: `Bearer ${remoteToken}` }, signal: AbortSignal.timeout(60 * 60_000) });
    if (!response.ok) throw new UserError(`${url.replace(remoteUrl, '')} returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return response;
  };
  const remote = filesSchema.parse(await (await get(`${base}/files`)).json()).files.find(f => f.path === name);
  if (!remote) throw new UserError(`the receiver no longer has ${manifest.id}'s video`);
  await privateDir(cli.config.work);
  // Into the work folder first, so a cut connection never leaves half a video in the bundle.
  const staging = join(cli.config.work, `video-${manifest.id}-${name}`);
  const response = await get(`${base}/files/${encodeURIComponent(remote.path)}`);
  if (!response.body) throw new UserError(`empty response for ${manifest.id}'s video`);
  await pipeline(Readable.fromWeb(response.body as ReadableStream), createWriteStream(staging, { mode: 0o600 }));
  if ((await stat(staging)).size !== remote.bytes || await sha256File(staging) !== remote.sha256) {
    await rm(staging, { force: true });
    throw new UserError(`${manifest.id}'s video arrived corrupted (size or sha256 mismatch); run it again`);
  }
  await rename(staging, path);
  return path;
}

/** `polycap video <id>`: makes sure the original is here and prints where. */
export async function video(cli: Cli, ref: string): Promise<string> {
  const session = await resolveSession(cli.config, ref);
  const had = session.manifest.media.video !== undefined && await exists(join(session.dir, session.manifest.media.video));
  const path = await ensureVideo(cli, session);
  const bytes = (await stat(path)).size;
  cli.print(cli.json ? JSON.stringify({ path, bytes, downloaded: !had }) : `${path}\t${(bytes / 1_048_576).toFixed(1)} MB${had ? '' : '\tdownloaded from the receiver'}`);
  return path;
}
