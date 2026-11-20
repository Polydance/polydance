import { lstat, mkdir, readlink, symlink, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserError } from '../errors.js';
import type { Cli } from './context.js';

export const SKILL_NAME = 'polydance-capture';
/** The skill's name before the rename to Polydance Capture (2026-10-02); a link under it to this repository is replaced. */
const OLD_SKILL_NAME = 'headset-session';
export const repoSkillDir = () => resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skill');
export const defaultSkillsDir = () => join(homedir(), '.claude', 'skills');

/** Whether an agent on this machine reads this polycap's skill: linked here, linked elsewhere, a copy, or absent. */
export async function skillState(skillsDir = defaultSkillsDir()): Promise<{ ok: boolean; detail: string }> {
  const target = join(skillsDir, SKILL_NAME), shown = target.replace(homedir(), '~');
  const existing = await lstat(target).catch(() => null);
  if (!existing) return { ok: false, detail: `not installed: polycap install-skill (Claude Code and Goose read ${skillsDir.replace(homedir(), '~')})` };
  if (!existing.isSymbolicLink()) return { ok: false, detail: `${shown} is a copy, which does not update with polycap: polycap install-skill --force links it` };
  const current = resolve(dirname(target), await readlink(target));
  return current === repoSkillDir() ? { ok: true, detail: `${shown} -> this polycap's skill/` } : { ok: false, detail: `${shown} links to ${current}, not this polycap's skill: polycap install-skill --force` };
}

/** Link the whole skill (including its playbook) into the local skills directory. Goose also
 * discovers this compatibility location. Files stay current; already-loaded session text may not. */
export async function installSkill(cli: Cli, options: { force: boolean; skillsDir?: string }): Promise<string> {
  const source = repoSkillDir();
  const skillsDir = options.skillsDir ?? defaultSkillsDir();
  const target = join(skillsDir, SKILL_NAME);
  await mkdir(skillsDir, { recursive: true });
  const existing = await lstat(target).catch(() => null);
  if (existing) {
    const current = existing.isSymbolicLink() ? resolve(dirname(target), await readlink(target)) : null;
    if (current === source) { cli.print(`already installed: ${target} -> ${source}`); return target; }
    if (!options.force) throw new UserError(`${target} exists${current ? ` (links to ${current})` : ''}. Re-run with --force to replace it.`);
    await unlink(target);
  }
  await symlink(source, target, 'dir');
  cli.print(`installed: ${target} -> ${source}`);
  // The old name would load the same skill twice; only our own link is removed, never a folder.
  const old = join(skillsDir, OLD_SKILL_NAME);
  const oldLink = await lstat(old).catch(() => null);
  if (oldLink?.isSymbolicLink() && resolve(dirname(old), await readlink(old)) === source) {
    await unlink(old);
    cli.print(`removed the old link ${old}`);
  }
  return target;
}
