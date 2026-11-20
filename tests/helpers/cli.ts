import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Cli } from '../../src/commands/context.js';
import { loadConfig, type Config } from '../../src/config.js';

export interface TestCli extends Cli { lines: string[]; warnings: string[] }

export async function testCli(env: NodeJS.ProcessEnv = {}, overrides: Partial<Config> = {}): Promise<TestCli> {
  const root = await mkdtemp(join(tmpdir(), 'polycap-root-'));
  // Hooks come from a file in the temp root unless a test names one: never the user's own hooks.json,
  // whose routine would otherwise run on every session a test processes.
  // Likewise the speaker reader: a test names a fake one, never the one built in this checkout.
  const config = loadConfig({ POLYCAP_ROOT: root, POLYCAP_STABLE_MS: '0', POLYCAP_MIN_AGE_MS: '0', POLYCAP_HOOKS: join(root, 'hooks.json'), POLYCAP_SPEAKERS_BIN: join(root, 'no-speaker-reader'), ...env }, overrides);
  const lines: string[] = [], warnings: string[] = [];
  return { config, json: false, print: line => lines.push(line), warn: line => warnings.push(line), lines, warnings };
}
