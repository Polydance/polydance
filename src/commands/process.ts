import { UserError } from '../errors.js';
import { HooksStopped, runSessionHooks, type HooksOutcome } from '../hook-run.js';
import { loadHooks, type Hook } from '../hooks.js';
import { processSession } from '../pipeline/run.js';
import { isPending, listSessions, resolveSession, STEP_NAMES, type SessionManifest, type StepName } from '../session.js';
import type { Cli } from './context.js';

/** `hooks: false` is --no-hooks: the pipeline only. */
export interface ProcessCommandOptions { refs: string[]; all?: boolean; force: boolean; step?: string; hooks?: boolean }

/**
 * Processes named sessions, every session (--all), or every session with a pending step, then runs
 * the routine hooks (docs/MAC.md H1) for each one that is now finished: whose pipeline this run
 * finished, or that was named. `--all` alone never starts hooks on bundles that were already
 * finished, so relabelling the library is not a hundred agent runs. A hook's failure is recorded in
 * the session's hook-runs.json, not the exit code; a hooks file that is not valid is an error, raised
 * once every session has been processed.
 */
export async function processCommand(cli: Cli, options: ProcessCommandOptions): Promise<SessionManifest[]> {
  const only = options.step as StepName | undefined;
  if (only && !STEP_NAMES.includes(only)) throw new UserError(`--step must be one of ${STEP_NAMES.join(', ')}`);
  if (options.all && options.refs.length) throw new UserError('Give session ids or --all, not both');
  const targets = options.refs.length
    ? await Promise.all(options.refs.map(ref => resolveSession(cli.config, ref)))
    : (await listSessions(cli.config, cli.warn)).filter(s => options.all || isPending(s.manifest));
  if (!targets.length) { cli.print('Nothing pending. Use `polycap process <id> --force` to redo one.'); return []; }
  const log = cli.json ? () => {} : cli.print;
  // The hooks file is read once, when the first session is ready for it; a bad one stops every hook.
  let hooks: Hook[] | undefined, configError: string | undefined;
  const hookErrors: string[] = [];
  const done: SessionManifest[] = [];
  const hookOutcomes = new Map<string, HooksOutcome>();
  for (const target of targets) {
    const wasPending = isPending(target.manifest);
    const manifest = await processSession(cli.config, target.dir, { force: options.force, only, log });
    done.push(manifest);
    if (options.hooks === false || configError || isPending(manifest) || !(wasPending || options.refs.length)) continue;
    try { hooks ??= (await loadHooks(cli.config.hooksFile)).hooks; }
    catch (error) { configError = error instanceof Error ? error.message : String(error); continue; }
    try {
      const outcome = await runSessionHooks(cli.config, target.dir, { hooks, log });
      hookOutcomes.set(manifest.id, outcome);
      if (outcome.busy) cli.warn(`${manifest.id}: hooks not run here: ${outcome.busy}`);
    } catch (error) {
      if (error instanceof HooksStopped) throw error;
      hookErrors.push(`${manifest.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (cli.json) cli.print(JSON.stringify(done.map(m => ({ id: m.id, steps: m.steps, frameCount: m.frameCount, markerCount: m.markerCount, ...(hookOutcomes.has(m.id) ? { hooks: hookOutcomes.get(m.id)!.runs } : {}) }))));
  if (configError) throw new UserError(`The pipeline ran, but no hooks were run: ${configError}`);
  if (hookErrors.length) throw new UserError(`The pipeline ran, but hooks could not run for ${hookErrors.length === 1 ? 'one session' : `${hookErrors.length} sessions`}:\n${hookErrors.join('\n')}`);
  return done;
}
