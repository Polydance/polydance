import { z } from 'zod';
import { exists, readJson, writeJsonAtomic } from './fsx.js';

const entrySchema = z.strictObject({
  key: z.string(), serial: z.string(), remotePath: z.string(), name: z.string(),
  bytes: z.number().int().nonnegative(), mtimeMs: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/), localPath: z.string(), pulledAt: z.string(), sessionId: z.string().optional(),
});
const ledgerSchema = z.strictObject({ version: z.literal(1), entries: z.array(entrySchema) });
export type LedgerEntry = z.infer<typeof entrySchema>;

/** Identity of a remote file as observed. A re-recorded file with the same name but new size or mtime is new. */
export const ledgerKey = (serial: string, remotePath: string, bytes: number, mtimeMs: number) => `${serial}|${remotePath}|${bytes}|${mtimeMs}`;

/** Which remote files were already pulled. Rewritten atomically; never trimmed, so the device copy can stay. */
export class Ledger {
  private constructor(private readonly file: string, private readonly data: z.infer<typeof ledgerSchema>) {}

  static async open(file: string): Promise<Ledger> {
    const data = await exists(file) ? await readJson(file, ledgerSchema) : { version: 1 as const, entries: [] };
    return new Ledger(file, data);
  }
  has(key: string): boolean { return this.data.entries.some(e => e.key === key); }
  entries(): readonly LedgerEntry[] { return this.data.entries; }
  add(entry: LedgerEntry): void {
    if (this.has(entry.key)) throw new Error(`Ledger already has ${entry.key}`);
    this.data.entries.push(entry);
  }
  async save(): Promise<void> { await writeJsonAtomic(this.file, this.data); }
}
