export const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** mm:ss, or h:mm:ss past an hour; floored so a transcript clock is never later than the words. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Filename-safe stamp: 01m23s, or 1h02m03s past an hour. */
export function frameStamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h > 0 ? `${h}h${pad(m)}m${pad(s)}s` : `${pad(m)}m${pad(s)}s`;
}

/** Accepts mm:ss, h:mm:ss, plain seconds, 83s, or 1m23s. Returns milliseconds. */
export function parseClock(text: string): number {
  const t = text.trim();
  const clock = t.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?(?:\.(\d{1,3}))?$/);
  if (clock) {
    const [a, b, c] = [Number(clock[1]), Number(clock[2]), clock[3] === undefined ? undefined : Number(clock[3])];
    const seconds = c === undefined ? a * 60 + b : a * 3600 + b * 60 + c;
    return seconds * 1000 + (clock[4] ? Number(clock[4].padEnd(3, '0')) : 0);
  }
  const units = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s?)?$/);
  if (units && t !== '' && (units[1] || units[2] || units[3])) {
    return Math.round(((Number(units[1] ?? 0) * 3600) + (Number(units[2] ?? 0) * 60) + Number(units[3] ?? 0)) * 1000);
  }
  throw new Error(`Cannot read time "${text}"; use mm:ss, h:mm:ss, 83, or 1m23s`);
}

/** Local wall-clock stamp for folder names: 2026-10-01T14-22-05. */
export function localStamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}
