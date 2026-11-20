/**
 * `polycap connect CODE` and `polycap disconnect` (docs/THREADS.md "Connecting your own agent", 2026-11-20).
 * Someone signed in on a headset asks Polydance there for a code and types it here; the receiver answers with a
 * token of this machine's own, which reaches what that person does: their threads, their own projects and the
 * recordings in them. The token is written to the settings file (0600), or with --save to a private file for one
 * repository, and is never printed. A code works once, so everything that could stop the token being kept is
 * checked before the code is spent. `disconnect` gives the token up on the receiver and takes it out here.
 */
import { mkdir, open, readFile, rename, rm, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { readEnvFile, remoteUrlAllowed, userConfigFile } from '../config.js';
import { UserError } from '../errors.js';
import { exists } from '../fsx.js';
import { agentLabelSchema, codeSchema } from '../pairing.js';
import { TOKEN_PATTERN } from '../server/tokens.js';
import { USER_ID } from '../threads.js';
import type { Cli } from './context.js';
import { remote, RemoteError } from './remote.js';

/** Where `polycap connect` goes when nothing says otherwise: the hosted receiver newcomers are invited to. */
export const HOSTED_RECEIVER = 'https://capture.polydance.net';

const redeemedSchema = z.looseObject({
  token: z.string().regex(TOKEN_PATTERN), id: z.string(), label: z.string().optional(), expiresAt: z.string(),
  person: z.looseObject({ name: z.string() }),
});

export interface ConnectOptions {
  url?: string; label?: string; save?: string; replace?: boolean;
  /** For tests: the settings file, and the environment that overrides it. */
  configFile?: string; env?: NodeJS.ProcessEnv;
}

const platformLabel = () => ({ darwin: 'Mac', linux: 'Linux', win32: 'Windows' } as Record<string, string>)[process.platform] ?? 'Computer';
const tidy = (path: string) => path.replace(homedir(), '~');

/** Sets or (with null) removes KEY=VALUE lines in the settings file, keeping every other line; the file is made 0600. */
async function editEnvFile(file: string, change: Record<string, string | null>): Promise<void> {
  const lines = await exists(file) ? (await readFile(file, 'utf8')).replace(/\n$/, '').split('\n') : [];
  for (const [key, value] of Object.entries(change)) {
    const at = lines.findIndex(line => line.trim().startsWith(`${key}=`));
    if (value === null) { if (at >= 0) lines.splice(at, 1); }
    else if (at >= 0) lines[at] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  await writePrivate(file, `${lines.join('\n')}\n`);
}

/** Writes a file only its owner can read, whole or not at all. An existing folder's mode is left alone. */
async function writePrivate(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  const handle = await open(temp, 'w', 0o600);
  try { await handle.writeFile(text); await handle.chmod(0o600); await handle.sync(); }
  catch (error) { await handle.close(); await unlink(temp).catch(() => undefined); throw error; }
  await handle.close();
  await rename(temp, file);
}

export async function connect(cli: Cli, typed: string, options: ConnectOptions = {}): Promise<void> {
  const code = codeSchema.safeParse(typed);
  if (!code.success) throw new UserError(`${code.error.issues[0].message}. In Polydance on the headset, open Connect your agent for one.`);
  const label = agentLabelSchema.safeParse(options.label ?? platformLabel());
  if (!label.success) throw new UserError('--label is what this machine is called, such as Mac: up to 40 characters');
  if (options.save !== undefined && !USER_ID.test(options.save)) throw new UserError(`--save ${options.save}: a token name is lowercase letters, digits and dashes`);
  const file = options.configFile ?? userConfigFile();
  const env = options.env ?? process.env;
  // Refuses a settings file others can read before anything is added to it.
  let kept: Record<string, string>;
  try { kept = readEnvFile(file); } catch (error) { throw new UserError((error as Error).message); }
  const url = (options.url ?? cli.config.remoteUrl ?? HOSTED_RECEIVER).replace(/\/+$/, '');
  if (!remoteUrlAllowed(url)) throw new UserError(`${url} must be https, or http on this machine or the local network`);
  const tokenFile = options.save ? join(dirname(file), 'tokens', options.save) : undefined;
  // A code works once: say what would stop the token being kept before spending it.
  if (tokenFile && await exists(tokenFile) && !options.replace) throw new UserError(`${tidy(tokenFile)} already exists; pick another --save name, or add --replace`);
  if (tokenFile && kept.POLYCAP_REMOTE_URL && kept.POLYCAP_REMOTE_URL.replace(/\/+$/, '') !== url) {
    throw new UserError(`${tidy(file)} points at ${kept.POLYCAP_REMOTE_URL}, and a saved token is used there; connect to that receiver, or change POLYCAP_REMOTE_URL first`);
  }
  if (!tokenFile && kept.POLYCAP_REMOTE_TOKEN && !options.replace) {
    throw new UserError(`${tidy(file)} already holds a token. Add --replace to put this one in its place, or --save NAME to keep this one for one repository (polycap link KEY --token NAME)`);
  }

  let response: Response, text: string;
  try {
    response = await fetch(`${url}/v1/agents`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code.data, label: label.data }),
    });
    text = await response.text();
  } catch (error) { throw new UserError(`could not reach ${url} (${error instanceof Error ? error.message : String(error)})`); }
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = undefined; }
  if (!response.ok) {
    const said = typeof json === 'object' && json && 'error' in json ? String((json as { error: unknown }).error) : `HTTP ${response.status}`;
    throw new UserError(`${url} did not connect this machine: ${said}`);
  }
  const redeemed = redeemedSchema.safeParse(json);
  if (!redeemed.success) throw new UserError(`${url} answered in a shape this polycap does not know; update polycap and ask the headset for a new code`);
  const { token, id, expiresAt, person } = redeemed.data;

  const where = tokenFile ?? file;
  try {
    if (tokenFile) {
      await writePrivate(tokenFile, `${token}\n`);
      if (!kept.POLYCAP_REMOTE_URL) await editEnvFile(file, { POLYCAP_REMOTE_URL: url });
    } else await editEnvFile(file, { POLYCAP_REMOTE_URL: url, POLYCAP_REMOTE_TOKEN: token });
  } catch (error) {
    // The code is spent and the token is lost with this process: the agent it made is still listed on the headset.
    throw new UserError(`connected as ${id}, but ${tidy(where)} could not be written (${error instanceof Error ? error.message : String(error)}). Disconnect ${label.data} in Polydance on the headset, fix the file and connect again with a new code.`);
  }
  if (cli.json) { cli.print(JSON.stringify({ id, label: label.data, person: person.name, url, expiresAt, saved: where })); return; }
  // A device token with no person behind it reads as its label alone.
  cli.print(`Connected to ${url} as ${person.name === label.data ? label.data : `${person.name} · ${label.data}`} (${id}).`);
  cli.print(`The token is in ${tidy(where)} (not shown) and expires ${expiresAt.slice(0, 10)}; connect again before then.`);
  if (!tokenFile && env.POLYCAP_REMOTE_TOKEN) cli.warn('POLYCAP_REMOTE_TOKEN is also set in the environment, which wins over the settings file: unset it to use this token');
  if (!options.url && !cli.config.remoteUrl) cli.print(`No receiver was set, so this used ${HOSTED_RECEIVER}.`);
  cli.print(tokenFile
    ? `Next: polycap link KEY --token ${options.save} in the repository this token is for.`
    : 'Next: polycap install-skill, then polycap project list for the projects it reaches, or polycap project new "Name" --host HOST to make one.');
}

/**
 * Gives a connected agent's token up: the receiver forgets it, and it comes out of the settings file (or, with a
 * name, its saved file is removed). A token the receiver no longer knows is still taken out here; one that was
 * made by hand is left alone, since only whoever runs the receiver can remove it.
 */
export async function disconnect(cli: Cli, options: { token?: string; configFile?: string } = {}): Promise<void> {
  const file = options.configFile ?? userConfigFile();
  if (options.token !== undefined && !USER_ID.test(options.token)) throw new UserError(`--token ${options.token}: a token name is lowercase letters, digits and dashes`);
  const tokenFile = options.token ? join(dirname(file), 'tokens', options.token) : undefined;
  let token: string | undefined;
  if (tokenFile) {
    const info = await stat(tokenFile).catch(() => undefined);
    if (!info) throw new UserError(`${tidy(tokenFile)} does not exist`);
    token = (await readFile(tokenFile, 'utf8')).trim();
  } else token = cli.config.remoteToken;
  if (!token || !TOKEN_PATTERN.test(token)) throw new UserError(tokenFile ? `${tidy(tokenFile)} does not hold a receiver token` : 'there is no token to disconnect: POLYCAP_REMOTE_TOKEN is not set');
  let gone = 'The receiver has forgotten this token.';
  try {
    await remote({ ...cli.config, remoteToken: token }).json('DELETE', '/v1/agents/self', z.looseObject({ disconnected: z.literal(true) }));
  } catch (error) {
    if (!(error instanceof RemoteError) || ![401, 403, 404].includes(error.status ?? 0)) throw error;
    if (error.status !== 401) throw new UserError('this token was not made by polycap connect, so it cannot disconnect itself; whoever runs the receiver removes it');
    gone = 'The receiver no longer knew this token.';
  }
  if (tokenFile) await rm(tokenFile);
  else {
    let kept: Record<string, string> = {};
    try { kept = readEnvFile(file); } catch { /* unreadable: nothing of ours to take out */ }
    if (kept.POLYCAP_REMOTE_TOKEN === token) await editEnvFile(file, { POLYCAP_REMOTE_TOKEN: null });
    else { cli.print(`${gone} It was not in ${tidy(file)}: remove POLYCAP_REMOTE_TOKEN from wherever it is set.`); return; }
  }
  cli.print(cli.json ? JSON.stringify({ disconnected: true }) : `${gone} It is out of ${tidy(tokenFile ?? file)}.`);
}
