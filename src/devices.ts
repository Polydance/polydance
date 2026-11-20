/** Shared headset identity and recording-folder profiles; unknown models remain generic Android. */
export type ProfileId = 'quest' | 'android-xr' | 'android';
export interface DeviceProfile { id: ProfileId; label: string; folders: string[]; confirmed: boolean; note?: string }

export const PROFILE_PROPS = ['ro.product.manufacturer', 'ro.product.brand', 'ro.product.model', 'ro.build.version.release'] as const;

/** adb devices replaces spaces with underscores; properties keep the original spelling. */
export const normalizeModel = (model: string) => model.trim().toLowerCase().replace(/[_\s]+/g, ' ');
export const isQuestModelName = (model: string) => /^quest(?: |$)/.test(normalizeModel(model));
export function isAndroidXrModel(model: string, manufacturer = ''): boolean {
  const name = normalizeModel(model);
  return name === 'android xr puck' || name === 'xreal aura' ||
    (name === 'aura' && normalizeModel(manufacturer) === 'xreal');
}

/** Decides where to look for recordings. Only the Quest folder is confirmed; others are best guesses until a recording exists. */
export function profileFor(props: Record<string, string>): DeviceProfile {
  const manufacturer = (props['ro.product.manufacturer'] ?? '').toLowerCase();
  const brand = (props['ro.product.brand'] ?? '').toLowerCase();
  const model = props['ro.product.model'] ?? '';
  if (manufacturer.includes('oculus') || brand.includes('oculus') || isQuestModelName(model)) {
    return { id: 'quest', label: 'Meta Quest', folders: ['/sdcard/Oculus/VideoShots'], confirmed: true };
  }
  const guess = ['/sdcard/Movies', '/sdcard/DCIM', '/sdcard/DCIM/Screen recordings', '/sdcard/Movies/Screen recordings'];
  if (isAndroidXrModel(model, manufacturer) || isAndroidXrModel(model, brand)) {
    return { id: 'android-xr', label: 'Android XR', folders: guess, confirmed: false, note: 'Recording folder unconfirmed. Make one recording, find it with `adb shell find /sdcard -name "*.mp4" -mmin -60`, then set POLYCAP_DEVICE_FOLDERS.' };
  }
  return { id: 'android', label: 'Android', folders: guess, confirmed: false, note: 'Generic profile. Set POLYCAP_DEVICE_FOLDERS if recordings live elsewhere.' };
}

export const describeDevice = (props: Record<string, string>) =>
  [props['ro.product.manufacturer'], props['ro.product.model'], props['ro.build.version.release'] ? `Android ${props['ro.build.version.release']}` : ''].filter(Boolean).join(' ');
