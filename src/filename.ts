export interface ParsedRecordingName { appPackage?: string; recordedAt?: Date }

// Quest names captures <package>-<yyyymmdd>-<hhmmss>.mp4, e.g. com.oculus.vrshell-20261001-142205.mp4.
const QUEST = /^(?<pkg>[A-Za-z][\w]*(?:\.[\w]+)+)-(?<date>\d{8})-(?<time>\d{6})\.(?:mp4|webm|mkv|mov)$/i;
// Stock Android recorders embed the same digits with other separators.
const GENERIC = /(?<date>\d{8})[-_T ]?(?<time>\d{6})/;

/** The timestamp is the device's local wall clock with no zone; it is read in this machine's zone. */
export function parseRecordingName(name: string): ParsedRecordingName {
  const quest = name.match(QUEST);
  const match = quest ?? name.match(GENERIC);
  if (!match?.groups) return {};
  const { date, time } = match.groups;
  const y = Number(date.slice(0, 4)), mo = Number(date.slice(4, 6)), d = Number(date.slice(6, 8));
  const h = Number(time.slice(0, 2)), mi = Number(time.slice(2, 4)), s = Number(time.slice(4, 6));
  const recordedAt = new Date(y, mo - 1, d, h, mi, s);
  const valid = recordedAt.getFullYear() === y && recordedAt.getMonth() === mo - 1 && recordedAt.getDate() === d && h < 24 && mi < 60 && s < 60;
  return { appPackage: quest?.groups?.pkg, recordedAt: valid ? recordedAt : undefined };
}

/** Last package segment, lower-case, safe for a folder name: marimba.marimba -> marimba. */
export function appSlug(appPackage: string | undefined): string {
  const last = appPackage?.split('.').filter(Boolean).pop() ?? '';
  return last.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'recording';
}

export const safeName = (value: string) => value.replace(/[^\w.-]+/g, '_');
