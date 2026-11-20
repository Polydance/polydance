import { chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Adb, type RemoteVideo } from '../adb.js';
import { ensureLayout } from '../config.js';
import { describeDevice, PROFILE_PROPS, profileFor } from '../devices.js';
import { UserError } from '../errors.js';
import { safeName } from '../filename.js';
import { exists, privateDir, sha256File, sleep } from '../fsx.js';
import { Ledger, ledgerKey } from '../ledger.js';
import { createSession } from '../session.js';
import type { Cli } from './context.js';

export interface PullOptions { device?: string; wait: boolean; dryRun: boolean; folders?: string[] }
export interface PullResult { created: string[]; skipped: RemoteVideo[]; known: number }

/**
 * Pulls recordings the ledger has not seen. A file must hold the same size and mtime across the stable gap
 * and be older than the minimum age, otherwise it is still being written. Device copies are never deleted.
 */
export async function pull(cli: Cli, options: PullOptions): Promise<PullResult> {
  const { config } = cli;
  const adb = new Adb(config.adb);
  await ensureLayout(config);
  const devices = (await adb.devices()).filter(d => d.state === 'device' && (!options.device || d.serial === options.device));
  if (!devices.length) throw new UserError(options.device ? `Device ${options.device} is not connected in "device" state.` : 'No connected device. Run `polycap devices`.');
  const ledger = await Ledger.open(config.ledgerFile);
  const result: PullResult = { created: [], skipped: [], known: 0 };
  for (const device of devices) {
    const props = await adb.getprops(device.serial, PROFILE_PROPS);
    const profile = profileFor(props);
    const folders = options.folders ?? config.deviceFolders ?? profile.folders;
    const first = await adb.listVideos(device.serial, folders);
    const fresh = first.filter(v => !ledger.has(ledgerKey(device.serial, v.path, v.bytes, v.mtimeMs)));
    result.known += first.length - fresh.length;
    if (!fresh.length) { cli.print(`${device.serial}: nothing new (${first.length} already pulled)${profile.confirmed ? '' : `; ${profile.note ?? ''}`}`); continue; }
    let eligible = fresh;
    if (options.wait) {
      if (config.stableMs > 0) await sleep(config.stableMs);
      const second = await adb.listVideos(device.serial, folders);
      const now = Date.now();
      eligible = fresh.filter(v => second.some(s => s.path === v.path && s.bytes === v.bytes && s.mtimeMs === v.mtimeMs) && now - v.mtimeMs >= config.minAgeMs);
    }
    result.skipped.push(...fresh.filter(v => !eligible.includes(v)));
    for (const v of result.skipped) cli.print(`${device.serial}: ${v.name} is still changing or too recent; try again shortly`);
    for (const video of eligible) {
      if (options.dryRun) { cli.print(`${device.serial}: would pull ${video.path} (${video.bytes} bytes)`); continue; }
      const rawDir = join(config.raw, safeName(device.serial));
      await privateDir(rawDir);
      let local = join(rawDir, video.name);
      for (let n = 2; await exists(local); n++) local = join(rawDir, `${video.name.replace(/(\.[^.]+)$/, '')}-${n}${video.name.match(/\.[^.]+$/)?.[0] ?? ''}`);
      cli.print(`${device.serial}: pulling ${video.name} (${(video.bytes / 1_048_576).toFixed(1)} MiB)`);
      await adb.pull(device.serial, video.path, local);
      await chmod(local, 0o600).catch(() => { /* best effort */ });
      const info = await stat(local);
      if (info.size !== video.bytes) throw new Error(`${video.name}: pulled ${info.size} bytes, device reports ${video.bytes}`);
      const [remoteHash, localHash] = await Promise.all([adb.sha256(device.serial, video.path), sha256File(local)]);
      if (remoteHash !== localHash) throw new Error(`${video.name}: sha256 differs between device and local copy`);
      const session = await createSession(config, {
        localFile: local, originalName: video.name, bytes: video.bytes, sha256: localHash, mtimeMs: video.mtimeMs,
        source: { kind: 'adb', serial: device.serial, deviceProfile: profile.id, deviceModel: describeDevice(props), remotePath: video.path },
      });
      ledger.add({ key: ledgerKey(device.serial, video.path, video.bytes, video.mtimeMs), serial: device.serial, remotePath: video.path, name: video.name, bytes: video.bytes, mtimeMs: video.mtimeMs, sha256: localHash, localPath: local, pulledAt: new Date().toISOString(), sessionId: session.manifest.id });
      await ledger.save();
      result.created.push(session.manifest.id);
      cli.print(`${device.serial}: created session ${session.manifest.id}`);
    }
  }
  if (cli.json) cli.print(JSON.stringify(result));
  return result;
}
