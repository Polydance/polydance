import { posix } from 'node:path';
import { exec, ToolError } from './exec.js';

export interface AdbDevice { serial: string; state: string; model?: string; product?: string; device?: string }
export interface RemoteVideo { path: string; name: string; bytes: number; mtimeMs: number }
export const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mkv', 'mov'] as const;

/** Parses `adb devices -l`. */
export function parseDevices(output: string): AdbDevice[] {
  return output.split('\n').map(line => line.trim())
    .filter(line => line && !line.startsWith('List of devices') && !line.startsWith('*'))
    .map(line => {
      const [serial = '', state = '', ...rest] = line.split(/\s+/);
      const extra: Record<string, string> = {};
      for (const part of rest) { const i = part.indexOf(':'); if (i > 0) extra[part.slice(0, i)] = part.slice(i + 1); }
      return { serial, state, model: extra.model, product: extra.product, device: extra.device };
    });
}

/** Parses `stat -c '%s %Y %n'` lines: size, mtime seconds, absolute path. Paths may contain spaces. */
export function parseStatLines(output: string): RemoteVideo[] {
  const videos: RemoteVideo[] = [];
  for (const raw of output.split('\n')) {
    const match = raw.replace(/\r$/, '').match(/^(\d+) (\d+) (\/.+)$/);
    if (!match) continue;
    videos.push({ bytes: Number(match[1]), mtimeMs: Number(match[2]) * 1000, path: match[3], name: posix.basename(match[3]) });
  }
  return videos;
}

/** Single-quotes a value for the device shell. The glob suffix is added outside the quotes by callers. */
export const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export class Adb {
  constructor(private readonly bin: string) {}

  async devices(): Promise<AdbDevice[]> {
    const { stdout } = await exec(this.bin, ['devices', '-l'], { timeoutMs: 30_000 });
    return parseDevices(stdout);
  }

  async shell(serial: string, command: string, timeoutMs = 60_000): Promise<string> {
    const { stdout } = await exec(this.bin, ['-s', serial, 'shell', command], { timeoutMs });
    return stdout;
  }

  async getprops(serial: string, keys: readonly string[]): Promise<Record<string, string>> {
    const props: Record<string, string> = {};
    for (const key of keys) props[key] = (await this.shell(serial, `getprop ${key}`)).trim();
    return props;
  }

  /** One stat call per folder; missing folders and empty globs are silent. */
  async listVideos(serial: string, folders: readonly string[]): Promise<RemoteVideo[]> {
    const found: RemoteVideo[] = [];
    for (const folder of folders) {
      const globs = VIDEO_EXTENSIONS.map(ext => `${shellQuote(folder)}/*.${ext}`).join(' ');
      const stdout = await this.shell(serial, `stat -c '%s %Y %n' ${globs} 2>/dev/null; true`);
      found.push(...parseStatLines(stdout));
    }
    return found;
  }

  async sha256(serial: string, remotePath: string): Promise<string> {
    const out = await this.shell(serial, `sha256sum ${shellQuote(remotePath)}`, 600_000);
    const match = out.trim().match(/^([0-9a-f]{64})\s/);
    if (!match) throw new ToolError(this.bin, `sha256sum on the device gave no digest for ${remotePath}`, null, out);
    return match[1];
  }

  /** -a keeps the device mtime on the local copy. */
  async pull(serial: string, remotePath: string, localPath: string): Promise<void> {
    await exec(this.bin, ['-s', serial, 'pull', '-a', remotePath, localPath], { timeoutMs: 30 * 60_000 });
  }
}
