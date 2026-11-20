/** Platform identity, Gradle outputs and wireless policy shared by the Mac CLI and device selection. */
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { isAndroidXrModel, isQuestModelName } from '../../src/devices.js';
import { UserError } from '../../src/errors.js';

export const platformIdSchema = z.enum(['quest', 'android-xr']);
export type PlatformId = z.infer<typeof platformIdSchema>;
export interface Platform {
  id: PlatformId;
  label: string;
  plural: string;
  flavor: string;
  matchesModel: (model: string, manufacturer?: string) => boolean;
  legacyWifiPort?: number;
  wifiHelp: string;
  installedHint: string;
}
export const PLATFORMS: Record<PlatformId, Platform> = {
  quest: {
    id: 'quest', label: 'Quest', plural: 'Quests', flavor: 'quest', matchesModel: isQuestModelName,
    legacyWifiPort: 5555,
    wifiHelp: 'Wi-Fi adb has to be switched on once over USB: plug the Quest in, then npm run app -- wifi --platform quest',
    installedHint: 'In the headset it is under Library → Unknown sources → Polydance.',
  },
  'android-xr': {
    id: 'android-xr', label: 'Android XR', plural: 'Android XR headsets', flavor: 'androidXr', matchesModel: isAndroidXrModel,
    wifiHelp: 'Android XR uses Wireless debugging in the device developer settings. Enable it, then run `adb pair IP:PAIRING_PORT` (enter the pairing code when prompted) and `adb connect IP:CONNECT_PORT`. Use the separate connection port shown by the device, not the pairing port; then npm run app -- install --platform android-xr --device IP:CONNECT_PORT. This command does not run adb tcpip.',
    installedHint: 'Open Polydance from the device app launcher (or use --launch).',
  },
};

export function platformFor(value: unknown = 'quest'): Platform {
  const parsed = platformIdSchema.safeParse(value);
  if (!parsed.success) throw new UserError('--platform must be quest or android-xr');
  return PLATFORMS[parsed.data];
}

export const ANDROID_DIR = fileURLToPath(new URL('../android/', import.meta.url));
export function buildTarget(platform: Platform, release = false): { task: string; apk: string } {
  const variant = release ? 'release' : 'debug';
  const title = (s: string) => s[0].toUpperCase() + s.slice(1);
  return {
    task: `assemble${title(platform.flavor)}${title(variant)}`,
    apk: resolve(ANDROID_DIR, `app/build/outputs/apk/${platform.flavor}/${variant}/app-${platform.flavor}-${variant}.apk`),
  };
}

/** Never invent Android XR's dynamic connection port; bracket IPv6 to keep host and port unambiguous. */
export function connectTarget(value: string, platform: Platform): string {
  const match = /^(\[[^\]]+\]|[A-Za-z0-9][A-Za-z0-9.-]*)(?::([0-9]+))?$/.exec(value);
  if (!match || (match[1].startsWith('[') && isIP(match[1].slice(1, -1)) !== 6)) {
    throw new UserError('--connect needs HOST:PORT (bracket IPv6 addresses)');
  }
  const port = match[2] === undefined ? platform.legacyWifiPort : Number(match[2]);
  if (port === undefined) throw new UserError(`--connect for ${platform.label} requires an explicit connection port. ${platform.wifiHelp}`);
  if (!z.number().int().min(1).max(65535).safeParse(port).success) throw new UserError('--connect port must be between 1 and 65535');
  return `${match[1]}:${port}`;
}

/** Properties, not manufacturer alone, authorize an install. Overrides never relax recording safety. */
export function assertPlatform(platform: Platform, serial: string, model: string, manufacturer = '', anyDevice = false): void {
  if (!platform.matchesModel(model, manufacturer) && !anyDevice) {
    throw new UserError(`${serial} is not a recognized ${platform.label} (model: ${model || 'unknown'}); select the correct --platform and --device, or --any-device to install anyway`);
  }
}
