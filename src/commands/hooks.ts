/**
 * `polycap hooks list` and `polycap hooks run` (docs/MAC.md H1 to H3): what is configured to run when a
 * bundle is ready, and running it for one session by hand, once more with --force. `polycap process`
 * runs the same hooks by itself when it finishes a session's pipeline.
 */
import { UserError } from '../errors.js';
import { runSessionHooks, type HooksOutcome } from '../hook-run.js';
import { hookRunLine, loadHooks, type Hook } from '../hooks.js';
import { isPending, resolveSession, STEP_NAMES } from '../session.js';
import type { Cli } from './context.js';
import { table } from './context.js';

const filter = (hook: Hook) => [hook.when.mode === 'any' ? 'every session' : `${hook.when.mode}s`, hook.when.minMinutes ? `at least ${hook.when.minMinutes} min` : ''].filter(Boolean).join(', ');

export async function hooksList(cli: Cli): Promise<Hook[]> {
  const { file, found, hooks } = await loadHooks(cli.config.hooksFile);
  // A hook's env can hold its own secrets: their names are shown, never their values.
  if (cli.json) { cli.print(JSON.stringify({ file, found, hooks: hooks.map(({ env, ...hook }) => ({ ...hook, envNames: Object.keys(env) })) })); return hooks; }
  if (!found) { cli.print(`No hooks: ${file} does not exist. docs/MAC.md "Starting Robin's routine" has an example.`); return hooks; }
  if (!hooks.length) { cli.print(`No hooks in ${file}.`); return hooks; }
  cli.print(`${file}:`);
  cli.print(table(hooks.map(h => [h.name, filter(h), h.cwd ?? '~', `${h.timeoutMinutes} min`, h.run[0]]), ['hook', 'for', 'cwd', 'timeout', 'runs']));
  return hooks;
}

export interface HooksRunOptions { hook?: string; force?: boolean }

/** Runs a finished session's hooks now: those not yet run, or with --force all of them again; --hook picks one. */
export async function hooksRun(cli: Cli, ref: string, options: HooksRunOptions = {}): Promise<HooksOutcome> {
  const session = await resolveSession(cli.config, ref);
  if (isPending(session.manifest)) {
    const pending = STEP_NAMES.filter(n => session.manifest.steps[n].status === 'pending');
    throw new UserError(`${session.manifest.id} is not finished (${pending.join(', ')} pending); hooks run on a finished bundle. Run polycap process ${session.manifest.id} first.`);
  }
  const { hooks, file, found } = await loadHooks(cli.config.hooksFile);
  if (!found) throw new UserError(`No hooks: ${file} does not exist`);
  const outcome = await runSessionHooks(cli.config, session.dir, { hooks, only: options.hook, force: options.force, log: cli.json ? () => {} : cli.print });
  if (cli.json) { cli.print(JSON.stringify({ id: outcome.id, dir: outcome.dir, ran: outcome.ran, notRun: outcome.notRun, ...(outcome.busy ? { busy: outcome.busy } : {}), runs: outcome.runs })); return outcome; }
  if (outcome.busy) cli.print(`not run: ${outcome.busy}`);
  for (const [name, why] of Object.entries(outcome.notRun)) cli.print(`${name}: not run, ${why}`);
  for (const name of outcome.ran) cli.print(hookRunLine(name, outcome.runs[name], hooks.find(h => h.name === name)));
  return outcome;
}
