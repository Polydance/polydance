import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { UserError } from '../errors.js';
import { exists, privateDir } from '../fsx.js';
import { newToken, SCOPES, type Scope } from '../server/tokens.js';
import { WELCOME_ID } from '../server/welcome.js';
import { PROJECT_KEY, USER_ID } from '../threads.js';
import { tokensDir } from './thread.js';
import type { Cli } from './context.js';

/**
 * Makes a token for the hosted receiver. The server gets only the JSON line with its sha256, added to
 * POLYCAP_SERVER_TOKENS. The token is printed once, or with --save written to a private file under
 * ~/.config/polycap/tokens/ and never printed, for an agent's repository to name in .polycap.json.
 * Every token says who it is for (2026-11-12, least privilege by default, docs/SHARING-SECURITY-RESEARCH.md):
 * --member makes a thread-scoped token for someone outside the team (a tester's own agent): it reaches, and
 * with `read` syncs, only the threads its person is a member of. --team makes one of the team's own, which
 * sees every thread in its projects and with `read` the whole library. Neither is refused, so forgetting the
 * flag never makes the wider kind. A token expires after 90 days unless --expires says otherwise (2026-11-12):
 * a number of days, a date (the end of that day, UTC), or `never`, which Robin's own devices may want.
 */
export async function tokenNew(cli: Cli, options: { id: string; scopes: string[]; projects?: string[]; label?: string; user?: string; member?: boolean; team?: boolean; expires?: string; save?: string }, now = Date.now()): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(options.id)) throw new UserError('--id is lowercase letters, digits and dashes, for example quest3 or mac');
  if (options.id === WELCOME_ID) throw new UserError(`--id ${WELCOME_ID} is the receiver's own, for the Welcome thread; choose another`);
  const scopes = options.scopes.length ? options.scopes : ['upload'];
  for (const s of scopes) if (!SCOPES.includes(s as Scope)) throw new UserError(`--scope must be ${SCOPES.join(' or ')}`);
  const projects = (options.projects ?? []).map(p => p.toUpperCase());
  for (const p of projects) if (!PROJECT_KEY.test(p)) throw new UserError(`--project ${p} is not a project key such as MUS`);
  if (options.user !== undefined && !USER_ID.test(options.user)) throw new UserError(`--user ${options.user}: a user id is lowercase letters, digits and dashes`);
  if (options.member && options.team) throw new UserError('--member and --team: say one; --member for someone outside the team, --team for the team\'s own');
  if (!options.member && !options.team) {
    throw new UserError('say who this token is for: --member --user ID for someone outside the team (it sees only the threads their person is in), '
      + 'or --team for the team\'s own devices and agents (every thread in its projects, and with --scope read the whole library)');
  }
  // Thread-scoped (2026-10-21): for someone outside the team, so it is bound to their person.
  if (options.member && !options.user) throw new UserError('--member needs --user: the person whose threads this token reaches');
  if (options.save !== undefined && !USER_ID.test(options.save)) throw new UserError(`--save ${options.save}: a token name is lowercase letters, digits and dashes`);
  const expiresAt = expiryFor(options.expires, now);
  const { token, sha256 } = newToken();
  const grant = { id: options.id, sha256, scopes, ...(projects.length ? { projects } : {}), ...(options.user ? { user: options.user } : {}), ...(options.member ? { threads: 'member' } : {}), ...(options.label ? { label: options.label } : {}), ...(expiresAt ? { expiresAt } : {}) };
  let saved: string | undefined;
  if (options.save) {
    const dir = tokensDir();
    await privateDir(dir);
    saved = join(dir, options.save);
    if (await exists(saved)) throw new UserError(`${saved} already exists; pick another --save name or remove it first`);
    await writeFile(saved, `${token}\n`, { mode: 0o600 });
  }
  if (cli.json) { cli.print(JSON.stringify({ ...(saved ? { saved } : { token }), grant })); return; }
  if (saved) cli.print(`Token saved to ${saved} (not shown). Name it in a repository's .polycap.json: polycap link KEY --token ${options.save}\n`);
  else cli.print(`Token (shown once; store it where it is used, never in a repository):\n\n  ${token}\n`);
  cli.print(expiresAt ? `It expires ${expiresAt.slice(0, 10)} (${Math.round((Date.parse(expiresAt) - now) / DAY)} days); --expires never makes one that does not.\n` : 'It never expires.\n');
  cli.print(`Add this entry to the server's POLYCAP_SERVER_TOKENS array:\n\n  ${JSON.stringify(grant)}\n`);
}

const DAY = 24 * 3600_000;
/** What `polycap token new` gives a token unless told otherwise: between GitHub's suggested 30 days and GitLab's default 365. */
export const DEFAULT_EXPIRY_DAYS = 90;
const MAX_DAYS = 3650;

/** --expires: 90 days when unset; `never`; `30d`; or a date, which lasts to the end of that day (UTC). At most ten years. */
export function expiryFor(value: string | undefined, now: number): string | undefined {
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  if (value === undefined) return iso(now + DEFAULT_EXPIRY_DAYS * DAY);
  if (value === 'never') return undefined;
  const days = value.match(/^(\d{1,4})d$/);
  if (days) {
    const n = Number(days[1]);
    if (n < 1 || n > MAX_DAYS) throw new UserError(`--expires ${value}: from 1d to ${MAX_DAYS}d`);
    return iso(now + n * DAY);
  }
  const date = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const end = date ? Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]), 23, 59, 59) : NaN;
  if (!date || new Date(end).toISOString().slice(0, 10) !== value) throw new UserError(`--expires ${value}: say a number of days (90d), a date (2027-02-10) or never`);
  if (end <= now) throw new UserError(`--expires ${value}: that day is over`);
  if (end - now > MAX_DAYS * DAY) throw new UserError(`--expires ${value}: at most ten years from now`);
  return iso(end);
}
