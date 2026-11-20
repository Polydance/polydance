import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, chmod, copyFile, link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ZodType } from 'zod';

/** Recordings are private. Every directory the tool creates is owner-only. */
export async function privateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => { /* Not fatal on filesystems without modes. */ });
}

export async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

/** Atomically replace JSON, syncing both its contents and the directory entry before success. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const parent = dirname(file);
  await privateDir(parent);
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let ownsTemp = false;
  try {
    const handle = await open(temp, 'wx', 0o600);
    ownsTemp = true;
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
    ownsTemp = false;
    // Directory fsync works on macOS and Linux. Fail closed if the platform or
    // filesystem cannot support it: an atomic rename alone is not durable.
    const directory = await open(parent, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    // Never remove a pre-existing temp when exclusive creation failed.
    if (ownsTemp) await unlink(temp);
  }
}

export async function readJson<T>(file: string, schema: ZodType<T>): Promise<T> {
  const text = await readFile(file, 'utf8');
  const result = schema.safeParse(JSON.parse(text));
  if (!result.success) throw new Error(`${file} does not match the expected schema: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return result.data;
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
  });
}

/** Hard link when the volume allows it (no second copy of a large video), otherwise copy. */
export async function linkOrCopy(from: string, to: string): Promise<'linked' | 'copied'> {
  try { await link(from, to); return 'linked'; }
  catch { await copyFile(from, to); await chmod(to, 0o600).catch(() => { /* best effort */ }); return 'copied'; }
}

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
