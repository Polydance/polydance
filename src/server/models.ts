/**
 * 3D models on the hosted receiver: <root>/thread-models/<PROJECT>/<sha256>.glb, pushed by the team before a
 * message names one in a launch, and fetched by a headset only through a thread whose message names it
 * (thread-routes.ts). Content-addressed, so pushing the same file again is a no-op and a model never
 * changes under a message. A body is written to a .part file while it is hashed, then checked as a .glb
 * (src/glb.ts) and renamed into place; anything else is refused and removed. One file a few tens of MB at
 * most, with a cap on all of them together, since nothing deletes them yet.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { exists, privateDir } from '../fsx.js';
import { inspectGlb, SHA256 } from '../glb.js';
import { PROJECT_KEY } from '../threads.js';
import { HttpError } from './respond.js';

export interface StoredModel { project: string; sha256: string; bytes: number }

export class ModelStore {
  private readonly busy = new Set<string>();

  constructor(readonly dir: string, readonly maxBytes: number, readonly totalBytes: number) {}

  /** Where a model lives; both parts are checked, so no path leaves the store. */
  path(project: string, sha256: string): string {
    if (!PROJECT_KEY.test(project) || !SHA256.test(sha256)) throw new HttpError(404, 'no such model');
    return join(this.dir, project, `${sha256}.glb`);
  }

  async has(project: string, sha256: string): Promise<boolean> {
    return PROJECT_KEY.test(project) && SHA256.test(sha256) && exists(this.path(project, sha256));
  }

  /** Bytes taken by every finished model. */
  async used(): Promise<number> {
    if (!await exists(this.dir)) return 0;
    let total = 0;
    for (const project of await readdir(this.dir)) {
      if (!PROJECT_KEY.test(project)) continue;
      for (const name of await readdir(join(this.dir, project))) if (name.endsWith('.glb')) total += (await stat(join(this.dir, project, name))).size;
    }
    return total;
  }

  /**
   * Keeps `length` bytes of `body` as this model, when they hash to `sha256` and make a valid .glb. A
   * model already here is not written again: the body is drained and the same answer given.
   */
  async put(project: string, sha256: string, length: number, body: Readable): Promise<StoredModel & { created: boolean }> {
    const file = this.path(project, sha256);
    if (!Number.isInteger(length) || length < 1) throw new HttpError(411, 'Content-Length must give the model\'s size');
    if (length > this.maxBytes) throw new HttpError(413, `models are at most ${this.maxBytes} bytes on this receiver; this one is ${length}`);
    if (await exists(file)) { body.resume(); return { project, sha256, bytes: (await stat(file)).size, created: false }; }
    const key = `${project}/${sha256}`;
    if (this.busy.has(key)) throw new HttpError(409, 'this model is being sent already; try again shortly');
    this.busy.add(key);
    const part = `${file}.part`;
    try {
      if (await this.used() + length > this.totalBytes) throw new HttpError(507, `the receiver's model store is full (${this.totalBytes} bytes); remove old models first`);
      await privateDir(this.dir); await privateDir(join(this.dir, project));
      const hash = createHash('sha256');
      let written = 0;
      const counted = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          written += chunk.length;
          if (written > length) return done(new HttpError(400, `the body is longer than its Content-Length of ${length}`));
          hash.update(chunk); done(null, chunk);
        },
      });
      await pipeline(body, counted, createWriteStream(part, { mode: 0o600 }));
      if (written !== length) throw new HttpError(400, `the body ended after ${written} of ${length} bytes; send it again`);
      if (hash.digest('hex') !== sha256) throw new HttpError(400, 'the model does not match the sha256 it was sent under');
      const { problems } = inspectGlb(await readFile(part));
      if (problems.length) throw new HttpError(400, problems.join('; '));
      await rename(part, file);
      return { project, sha256, bytes: length, created: true };
    } catch (error) {
      await rm(part, { force: true });
      throw error;
    } finally {
      this.busy.delete(key);
    }
  }
}
