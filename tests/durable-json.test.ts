import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonAtomic } from '../src/fsx.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename), unlink: vi.fn(actual.unlink) };
});
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
let dir: string;
let file: string;

beforeEach(async () => {
  vi.mocked(open).mockReset().mockImplementation(actual.open);
  vi.mocked(rename).mockReset().mockImplementation(actual.rename);
  vi.mocked(unlink).mockReset().mockImplementation(actual.unlink);
  dir = await mkdtemp(join(tmpdir(), 'polycap durability '));
  file = join(dir, 'receipt.json');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('durable atomic JSON writes', () => {
  // Windows cannot portably open/fsync directories with Node's file API.
  it.skipIf(process.platform === 'win32')('roundtrips and replaces private JSON without temporary siblings (real directory fsync)', async () => {
    await writeJsonAtomic(file, { receipt: 'first' });
    await writeJsonAtomic(file, { receipt: 'second', nested: { accepted: true } });
    expect(await readFile(file, 'utf8')).toBe(`${JSON.stringify({ receipt: 'second', nested: { accepted: true } }, null, 2)}\n`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect(await readdir(dir)).toEqual(['receipt.json']);
    expect(open).toHaveBeenCalledWith(expect.stringMatching(/\.tmp$/), 'wx', 0o600);
    expect(open).toHaveBeenCalledWith(dir, 'r');
  });

  it('awaits write, file sync, close, rename, directory sync and close in order', async () => {
    const events: string[] = [];
    const operation = (name: string) => vi.fn(async () => {
      await Promise.resolve();
      events.push(name);
    });
    const temporary = { writeFile: operation('write'), sync: operation('file sync'), close: operation('file close') };
    const directory = { sync: operation('directory sync'), close: operation('directory close') };
    vi.mocked(open)
      .mockResolvedValueOnce(temporary as unknown as Awaited<ReturnType<typeof open>>)
      .mockResolvedValueOnce(directory as unknown as Awaited<ReturnType<typeof open>>);
    vi.mocked(rename).mockImplementation(operation('rename'));
    await writeJsonAtomic(file, { accepted: true });
    events.push('resolved');
    expect(events).toEqual(['write', 'file sync', 'file close', 'rename', 'directory sync', 'directory close', 'resolved']);
    expect(temporary.writeFile).toHaveBeenCalledWith('{\n  "accepted": true\n}\n');
    expect(open).toHaveBeenNthCalledWith(1, expect.stringMatching(/\.tmp$/), 'wx', 0o600);
    expect(rename).toHaveBeenCalledWith(vi.mocked(open).mock.calls[0]![0], file);
    expect(open).toHaveBeenNthCalledWith(2, dir, 'r');
    expect(unlink).not.toHaveBeenCalled();
  });

  it.each(['writeFile', 'sync', 'close'] as const)('cleans up and preserves the old receipt when temporary %s fails', async operation => {
    await writeFile(file, '{"receipt":"old"}\n');
    const failure = new Error(`${operation} failed`);
    let closed = false;
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        await close();
        closed = true;
        if (operation === 'close') throw failure;
      });
      if (operation !== 'close') vi.spyOn(handle, operation).mockRejectedValueOnce(failure);
      return handle;
    });
    await expect(writeJsonAtomic(file, { receipt: 'new' })).rejects.toBe(failure);
    expect(closed).toBe(true);
    expect(rename).not.toHaveBeenCalled();
    expect(await readFile(file, 'utf8')).toBe('{"receipt":"old"}\n');
    expect(await readdir(dir)).toEqual(['receipt.json']);
  });

  it('cleans up a synced temporary file when rename fails', async () => {
    await writeFile(file, 'old receipt');
    const failure = new Error('rename failed');
    vi.mocked(rename).mockRejectedValueOnce(failure);
    await expect(writeJsonAtomic(file, { receipt: 'new' })).rejects.toBe(failure);
    expect(await readFile(file, 'utf8')).toBe('old receipt');
    expect(await readdir(dir)).toEqual(['receipt.json']);
  });

  it('never overwrites or unlinks a temporary file it did not exclusively create', async () => {
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      await actual.writeFile(args[0], 'someone else owns this temporary file');
      return actual.open(...args);
    });
    await expect(writeJsonAtomic(file, { receipt: 'new' })).rejects.toMatchObject({ code: 'EEXIST' });
    const temporary = vi.mocked(open).mock.calls[0]![0];
    expect(await readFile(temporary, 'utf8')).toBe('someone else owns this temporary file');
    expect(unlink).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });

  it.each(['EINVAL', 'ENOTSUP', 'EIO'])('fails closed and closes the directory when directory sync returns %s', async code => {
    const failure = Object.assign(new Error('directory sync failed'), { code });
    const directory = { sync: vi.fn().mockRejectedValueOnce(failure), close: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(open).mockImplementation(async (...args) => args[0] === dir
      ? directory as unknown as Awaited<ReturnType<typeof open>>
      : actual.open(...args));
    await expect(writeJsonAtomic(file, { accepted: true })).rejects.toBe(failure);
    expect(directory.close).toHaveBeenCalledOnce();
    // Rename already happened, but the caller must not acknowledge durability.
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ accepted: true });
    expect(await readdir(dir)).toEqual(['receipt.json']);
  });

  it('fails closed if the platform cannot open a directory for syncing', async () => {
    const failure = Object.assign(new Error('directory open unsupported'), { code: 'EISDIR' });
    vi.mocked(open).mockImplementation(async (...args) => {
      if (args[0] === dir) throw failure;
      return actual.open(...args);
    });
    await expect(writeJsonAtomic(file, { accepted: true })).rejects.toBe(failure);
    expect(await readdir(dir)).toEqual(['receipt.json']);
  });

  it('does not leave a temporary file when JSON serialization fails', async () => {
    await expect(writeJsonAtomic(file, { unsupported: 1n })).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });
});
