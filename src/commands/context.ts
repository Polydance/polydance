import type { Config } from '../config.js';

/** What every command gets: configuration, whether to emit JSON, and a line printer. */
export interface Cli { config: Config; json: boolean; print: (line: string) => void; warn: (line: string) => void }

export function table(rows: string[][], header?: string[]): string {
  const all = header ? [header, ...rows] : rows;
  const widths = all.reduce<number[]>((w, row) => row.map((cell, i) => Math.max(w[i] ?? 0, cell.length)), []);
  const line = (row: string[]) => row.map((cell, i) => i === row.length - 1 ? cell : cell.padEnd(widths[i])).join('  ').trimEnd();
  const out = all.map(line);
  if (header) out.splice(1, 0, widths.map(w => '-'.repeat(w)).join('  '));
  return out.join('\n');
}
