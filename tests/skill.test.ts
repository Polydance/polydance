/** Packaging/discovery regression checks; not a model-behavior or live-session reload test. */
import { mkdtemp, readFile, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { installSkill } from '../src/commands/install-skill.js';
import { loadConfig } from '../src/config.js';
import type { Cli } from '../src/commands/context.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('Polydance skill onboarding package', () => {
  it('exposes the same playbook through first install and an existing local link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polycap-skill-package-')); roots.push(root);
    const cli: Cli = { config: loadConfig({ POLYCAP_ROOT: join(root, 'library') }), json: false, print: () => {}, warn: () => {} };
    const options = { force: false, skillsDir: join(root, 'skills') };
    const installed = await installSkill(cli, options);
    const source = await readFile(join(repo, 'skill', 'references', 'in-conversation-wait.md'), 'utf8');
    expect(await readFile(join(installed, 'references', 'in-conversation-wait.md'), 'utf8')).toBe(source);
    expect(resolve(dirname(installed), await readlink(installed))).toBe(join(repo, 'skill'));
    expect(await installSkill(cli, options)).toBe(installed);
    expect(await readFile(join(installed, 'references', 'in-conversation-wait.md'), 'utf8')).toBe(source);
  });

  it('keeps the stable skill name, explicit onboarding trigger and all packaged Markdown links', async () => {
    const skillDir = join(repo, 'skill');
    const skill = await readFile(join(skillDir, 'SKILL.md'), 'utf8');
    const metadata = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1];
    expect(metadata).toContain('name: polydance-capture');
    expect(metadata?.split('\n').find(line => line.startsWith('description:'))).toContain('"use Polydance"');
    const localLinks = [...skill.matchAll(/\]\(([^)]+\.md)\)/g)].map(match => match[1]);
    expect(localLinks).toContain('references/in-conversation-wait.md');
    for (const link of localLinks) expect(await readFile(join(skillDir, link), 'utf8')).not.toBe('');
  });

  it('teaches the in-conversation wait and nothing of the removed router', async () => {
    const skill = await readFile(join(repo, 'skill', 'SKILL.md'), 'utf8');
    expect(skill).toContain('polycap thread watch MUS-12 --once --kind recording.ready');
    expect(skill).not.toMatch(/POLYCAP_ROUTER_TASK|feedback-loop\.md|Router-managed/);
  });
});
