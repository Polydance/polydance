/** Receiver operator linking: fake secrets, temporary files, no ports/network/headset. */
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('passes the standalone Python operator-link security and rerun tests', () => {
  const result = spawnSync('python3', ['-B', 'tests/meta_link_test.py', '-v'], { encoding: 'utf8', timeout: 20_000 });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain('Ran 25 tests');
  expect(result.stderr).toContain('OK');
});
