/** Platform-aware adb selection. Duplicate transports only coalesce with a nonempty hardware id. */
import type { AdbDevice } from '../../src/adb.js';
import { isQuestModelName } from '../../src/devices.js';
import { UserError } from '../../src/errors.js';
import { assertPlatform, PLATFORMS, type Platform } from './platform.js';

export const isQuestModel = (device: AdbDevice) => isQuestModelName(device.model ?? '');
/** Wi-Fi serials are host:port (adb connect) or an mDNS service name; anything else is USB. */
export const isNetworkSerial = (serial: string) => /:\d+$/.test(serial) || serial.includes('._adb-tls-connect.');

export function chooseDevice(devices: AdbDevice[], explicit: string | undefined, want: 'any' | 'usb' = 'any', hardware?: Map<string, string>, platform: Platform = PLATFORMS.quest, anyDevice = false): AdbDevice {
  const ready = devices.filter(d => d.state === 'device' && (want === 'any' || !isNetworkSerial(d.serial)));
  const matches = (d: AdbDevice) => platform.matchesModel(d.model ?? '');
  const list = () => devices.map(d => `${d.serial} (${d.model ?? 'unknown'}, ${d.state})`).join(', ') || 'none';
  if (explicit) {
    const found = devices.find(d => d.serial === explicit);
    if (!found) throw new UserError(`${explicit} is not connected; adb sees: ${list()}`);
    if (found.state !== 'device') throw new UserError(`${explicit} is ${found.state}; accept the debugging prompt in the headset`);
    if (want === 'usb' && isNetworkSerial(found.serial)) throw new UserError(`${explicit} is a network transport; --device must select a USB device`);
    assertPlatform(platform, found.serial, found.model ?? '', '', anyDevice);
    return found;
  }
  const candidates = ready.filter(matches);
  // Collapse each known hardware id independently: two physical headsets are still ambiguous.
  const groups = new Map<string, AdbDevice>();
  for (const candidate of candidates) {
    const id = hardware?.get(candidate.serial)?.trim();
    const key = id ? `hardware:${id}` : `transport:${candidate.serial}`;
    const previous = groups.get(key);
    if (!previous || isNetworkSerial(previous.serial)) groups.set(key, candidate);
  }
  if (groups.size === 1) return [...groups.values()][0];
  if (groups.size > 1) throw new UserError(`several ${platform.plural} are connected; pass --device: ${candidates.map(d => d.serial).join(', ')}`);
  const asleep = devices.filter(d => d.state !== 'device' && matches(d));
  if (asleep.length) {
    throw new UserError(`the ${platform.label} at ${asleep.map(d => `${d.serial} is ${d.state}`).join(', ')}: wake the headset (put it on or press the power button) and run this again`);
  }
  throw new UserError(ready.length
    ? `no ${platform.label} among the connected devices; pass --device${anyDevice ? ' to explicitly select a device for --any-device' : ' and the correct --platform'}: ${list()}`
    : `no ${want === 'usb' ? 'USB ' : ''}device is connected; adb sees: ${list()}`);
}

/** The headset's Wi-Fi address from `ip route`: the `src` of the wlan0 route, else the first `src`. */
export function parseWifiIp(ipRoute: string): string | undefined {
  const lines = ipRoute.split('\n');
  const pick = (line: string | undefined) => line?.match(/\bsrc (\d{1,3}(?:\.\d{1,3}){3})\b/)?.[1];
  return pick(lines.find(l => l.includes('wlan'))) ?? lines.map(pick).find(Boolean);
}

/** `adb connect` exits 0 even when it fails, so success is read from the text. */
/**
 * What to say when `adb connect` fails. "No route to host" while the headset answers ping is macOS 15's
 * Local Network privacy refusing the adb server process: a server started from an agent's shell can be
 * refused even when the app has the permission (seen 2026-10-04), while one started by Meta Quest
 * Developer Hub or Terminal is allowed.
 */
export function connectFailureHint(stdout: string, platform: Platform = PLATFORMS.quest): string {
  if (/no route to host/i.test(stdout)) {
    return 'macOS may be keeping this adb server off the local network. Run `adb kill-server`, then run adb in Terminal ' +
      'with Local Network access (or use Meta Quest Developer Hub for Quest), and try again.';
  }
  return `Same network as this Mac? ${platform.wifiHelp}`;
}

export function connectSucceeded(output: string): boolean {
  return /\b(connected to|already connected to)\b/.test(output) && !/failed|cannot|unable/i.test(output);
}

/**
 * Whether the app is recording right now, from two independent signals: the recording service is
 * running in the foreground (`dumpsys activity services`), or the newest run's video grew in the last
 * few seconds (`stat` against the device clock). Installing over a running app kills it, and a
 * recording cut off that way has no index and cannot be played, so either signal blocks an install.
 */
export function recordingInProgress(servicesDump: string, newestVideoMtimeS: number | undefined, deviceNowS: number): boolean {
  const service = /RecorderService/.test(servicesDump) && /isForeground=true/.test(servicesDump);
  const growing = newestVideoMtimeS !== undefined && deviceNowS - newestVideoMtimeS <= 5;
  return service || growing;
}

/**
 * Whether the installed Polydance can read every app's log for a take (docs/LOGS.md), from `dumpsys package`: it is
 * installed, its manifest asks for READ_LOGS (debug builds only; Meta prohibits it), and the headset has granted it,
 * which only `pm grant` over adb does. A development permission is listed with the runtime ones, as `granted=true`.
 */
export function parseLogsGrant(dump: string, pkg = 'net.polydance.capture'): { installed: boolean; declared: boolean; granted: boolean } {
  const installed = dump.includes(`Package [${pkg}]`);
  const declared = installed && /^\s*android\.permission\.READ_LOGS\s*$/m.test(dump);
  const granted = declared && /android\.permission\.READ_LOGS: granted=true\b/.test(dump);
  return { installed, declared, granted };
}
