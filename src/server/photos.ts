/**
 * Photos on the hosted receiver: <root>/thread-photos/<PROJECT>/<sha256>.jpg|.png (docs/THREADS.md, Photos,
 * 2026-11-07). Whatever arrives is checked and stripped (src/photo.ts) before anything is kept, and the
 * photo is named by the sha256 of the stripped file, so the same photo sent twice is one file and a photo
 * never changes under a message. A body is read into memory (it is 20 MB at most), written to a .part file
 * and renamed into place. Like models, nothing deletes photos yet, so all of them together are capped.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { exists, privateDir } from '../fsx.js';
import { SHA256 } from '../glb.js';
import { cleanPhoto, photoExtension, PHOTO_TYPES, type Photo, type PhotoType } from '../photo.js';
import { PROJECT_KEY } from '../threads.js';
import { HttpError } from './respond.js';

const FILE = /^[0-9a-f]{64}\.(jpg|png)$/;

export class PhotoStore {
  constructor(readonly dir: string, readonly maxBytes: number, readonly totalBytes: number) {}

  /** Where a photo lives; every part is checked, so no path leaves the store. */
  path(project: string, sha256: string, type: PhotoType): string {
    if (!PROJECT_KEY.test(project) || !SHA256.test(sha256)) throw new HttpError(404, 'no such photo');
    return join(this.dir, project, `${sha256}.${photoExtension(type)}`);
  }

  /** The photo's file and its facts, read from the file itself; undefined when it is not here. */
  async find(project: string, sha256: string): Promise<{ file: string; photo: Photo } | undefined> {
    if (!PROJECT_KEY.test(project) || !SHA256.test(sha256)) return undefined;
    for (const type of PHOTO_TYPES) {
      const file = this.path(project, sha256, type);
      if (!await exists(file)) continue;
      const cleaned = cleanPhoto(await readFile(file));
      // A kept photo that no longer reads as one is damage on disk: an error, never served.
      if (!cleaned.ok) throw new Error(`${file} is not a photo any more: ${cleaned.problem}`);
      return { file, photo: { sha256, ...cleaned.facts, bytes: cleaned.photo.length } };
    }
    return undefined;
  }

  /** Where a kept photo is, its type and size, without reading it: for serving one. */
  async locate(project: string, sha256: string): Promise<{ file: string; type: PhotoType; bytes: number } | undefined> {
    if (!PROJECT_KEY.test(project) || !SHA256.test(sha256)) return undefined;
    for (const type of PHOTO_TYPES) {
      const file = this.path(project, sha256, type);
      const info = await stat(file).catch(() => undefined);
      if (info?.isFile()) return { file, type, bytes: info.size };
    }
    return undefined;
  }

  /** Bytes taken by every kept photo. */
  async used(): Promise<number> {
    if (!await exists(this.dir)) return 0;
    let total = 0;
    for (const project of await readdir(this.dir)) {
      if (!PROJECT_KEY.test(project)) continue;
      for (const name of await readdir(join(this.dir, project))) if (FILE.test(name)) total += (await stat(join(this.dir, project, name))).size;
    }
    return total;
  }

  /**
   * Keeps the `length` bytes of `body` as a photo of `project` once they are a whole JPEG or PNG within the
   * limits, stripped. `contentType` must say what the bytes are. A photo already here is not written again.
   */
  async put(project: string, length: number, contentType: string | undefined, body: Readable): Promise<Photo & { created: boolean }> {
    if (!PROJECT_KEY.test(project)) throw new HttpError(404, `no project ${project}`);
    const declared = contentType?.split(';')[0].trim().toLowerCase();
    if (!PHOTO_TYPES.includes(declared as PhotoType)) { body.resume(); throw new HttpError(415, 'a photo is sent as image/jpeg or image/png'); }
    if (!Number.isInteger(length) || length < 1) { body.resume(); throw new HttpError(411, 'Content-Length must give the photo\'s size'); }
    if (length > this.maxBytes) { body.resume(); throw new HttpError(413, `photos are at most ${this.maxBytes} bytes on this receiver; this one is ${length}`); }
    const chunks: Buffer[] = [];
    let got = 0;
    for await (const chunk of body) {
      got += (chunk as Buffer).length;
      if (got > length) throw new HttpError(400, `the body is longer than its Content-Length of ${length}`);
      chunks.push(chunk as Buffer);
    }
    if (got !== length) throw new HttpError(400, `the body ended after ${got} of ${length} bytes; send it again`);
    const cleaned = cleanPhoto(Buffer.concat(chunks));
    if (!cleaned.ok) throw new HttpError(400, cleaned.problem);
    if (cleaned.facts.type !== declared) throw new HttpError(400, `the photo is ${cleaned.facts.type} but was sent as ${declared}`);
    const sha256 = createHash('sha256').update(cleaned.photo).digest('hex');
    const photo: Photo = { sha256, ...cleaned.facts, bytes: cleaned.photo.length };
    const file = this.path(project, sha256, cleaned.facts.type);
    if (await exists(file)) return { ...photo, created: false };
    if (await this.used() + photo.bytes > this.totalBytes) throw new HttpError(507, `the receiver's photo store is full (${this.totalBytes} bytes)`);
    await privateDir(this.dir); await privateDir(join(this.dir, project));
    // Two of the same photo at once write two parts of the same bytes; whichever renames last wins, harmlessly.
    const part = `${file}.${randomBytes(6).toString('hex')}.part`;
    try {
      await writeFile(part, cleaned.photo, { mode: 0o600 });
      await rename(part, file);
    } catch (error) {
      await rm(part, { force: true });
      throw error;
    }
    return { ...photo, created: true };
  }
}
