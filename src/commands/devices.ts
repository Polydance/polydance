import { Adb } from '../adb.js';
import { describeDevice, PROFILE_PROPS, profileFor } from '../devices.js';
import type { Cli } from './context.js';
import { table } from './context.js';

export async function devices(cli: Cli): Promise<void> {
  const adb = new Adb(cli.config.adb);
  const rows: Array<Record<string, unknown>> = [];
  for (const device of await adb.devices()) {
    if (device.state !== 'device') { rows.push({ serial: device.serial, state: device.state }); continue; }
    const props = await adb.getprops(device.serial, PROFILE_PROPS);
    const profile = profileFor(props);
    rows.push({ serial: device.serial, state: device.state, description: describeDevice(props), profile: profile.id, folders: cli.config.deviceFolders ?? profile.folders, confirmed: profile.confirmed, note: profile.note });
  }
  if (cli.json) { cli.print(JSON.stringify(rows, null, 2)); return; }
  if (!rows.length) { cli.print('No devices. Connect by USB, or `adb connect <ip:port>` for a paired headset.'); return; }
  cli.print(table(rows.map(r => [String(r.serial), String(r.state), String(r.description ?? ''), String(r.profile ?? ''), Array.isArray(r.folders) ? r.folders.join(', ') : '']), ['serial', 'state', 'device', 'profile', 'folders']));
  for (const r of rows) if (r.note) cli.print(`note (${String(r.serial)}): ${String(r.note)}`);
}
