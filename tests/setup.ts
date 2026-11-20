// Runs before every test file (vitest.config.ts `setupFiles`): gives the file its own scratch folder as
// the system temp folder and removes it once the file is done. Tests and the code they run make folders
// with mkdtemp(join(tmpdir(), …)) and seldom remove them; on 2026-11-12 that was ~10,000 folders a day in
// the Mac's temp folder (Robin). Child processes a test starts inherit TMPDIR, so their leftovers go too.
// Only a killed run leaves its polycap-test-* folder behind.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const previous = process.env.TMPDIR;
const scratch = await mkdtemp(join(tmpdir(), 'polycap-test-'));
process.env.TMPDIR = scratch;

// Registered before the file's own hooks, so it runs after them, once its servers and children are closed.
afterAll(async () => {
  if (previous === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previous;
  await rm(scratch, { recursive: true, force: true, maxRetries: 3 })
    .catch(error => console.warn(`could not remove ${scratch}: ${error}`));
});
