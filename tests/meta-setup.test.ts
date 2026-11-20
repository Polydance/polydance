/** Terminal wizard regressions run with fake secrets, isolated homes and no network/headset. */
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('passes the standalone Python setup-wizard security and rerun tests', () => {
  const result = spawnSync('python3', ['-B', 'tests/meta_setup_test.py', '-v'], { encoding: 'utf8', timeout: 20_000 });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain('Ran 15 tests');
  expect(result.stderr).toContain('OK');
});
