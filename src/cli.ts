import { parseArgs } from 'node:util';
import { legacySetup, loadConfig, readEnvFile, userConfigFile } from './config.js';
import { UserError } from './errors.js';
import { ToolError } from './exec.js';
import { TOOL_VERSION } from './version.js';
import type { Cli } from './commands/context.js';
import { devices } from './commands/devices.js';
import { doctor } from './commands/doctor.js';
import { importRecording } from './commands/import.js';
import { search, type FindOptions } from './commands/find.js';
import { frames, latest, list, show, transcript } from './commands/inspect.js';
import { installSkill } from './commands/install-skill.js';
import { hooksList, hooksRun } from './commands/hooks.js';
import { processCommand } from './commands/process.js';
import { pull } from './commands/pull.js';
import { serve } from './commands/serve.js';
import { sync } from './commands/sync.js';
import { exportCommand } from './commands/export.js';
import { video } from './commands/video.js';
import { tokenNew } from './commands/token.js';
import { upload } from './commands/upload.js';
import { connect, disconnect } from './commands/connect.js';
import { link, projectEdit, projectList, projectNew, threadList, threadMembers, threadNew, threadPending, threadReact, threadReply, threadShow, threadUpdate, threadWatch, threadWelcome, threadInvite, me, type LaunchFlags, type OptionGroups } from './commands/thread.js';

const USAGE = `polycap ${TOOL_VERSION}: headset recordings in, agent-ready bundles out.

  polycap doctor                         check tools, model and connected devices
  polycap devices                        list adb devices and the folders that will be watched
  polycap pull [--device S] [--no-wait] [--dry-run] [--folder P ...]
                                        pull new recordings and create sessions (nothing is deleted on the device)
  polycap import <video> [--app PKG] [--recorded-at ISO] [--tracks mic,app] [--meta FILE.meta.json]
                                        create a session from a local file; --tracks says which audio track is
                                        which, --meta is the recording app's description (a call's, docs/MAC.md)
  polycap process [<id> ... | --all] [--force] [--step NAME] [--no-hooks]
                                        run pending steps (probe, audio, transcribe, frames, pointing,
                                        markers, summary, storyboard); --all --step summary labels every bundle;
                                        then the hooks for each session it finished or was given (docs/MAC.md)
  polycap run [--no-hooks]               pull, then process everything pending
  polycap hooks list                     what runs when a bundle is ready (~/.config/polycap/hooks.json or POLYCAP_HOOKS)
  polycap hooks run <id> [--hook NAME] [--force]
                                        run a finished session's hooks now; each runs once unless --force,
                                        and --hook NAME runs that one whatever its filter says
  polycap upload <video> --thread KEY [--reply-to N [--launch L]] | --project KEY | --report [--meta FILE.meta.json] [--tracks mic,app]
                 [--token NAME] [--no-narration]
                                        send a walkthrough to the hosted receiver as a reply in a thread, as a
                                        new thread in a project, or as a report for the Polydance team, resuming
                                        an interrupted upload; L is the launch's index in message N, from 0.
                                        A token with the upload scope: --token NAME or POLYCAP_UPLOAD_TOKEN.
                                        A recording whose --meta has a call is refused: calls stay on this Mac
  polycap list | latest | show <id>      inspect sessions ("latest" works as an id everywhere)
  polycap list [--calls | --walkthroughs] [--since DAY] [--until DAY] [--meeting CODE] [--with NAME] [--thread KEY] [--limit N]
                                        find recordings: DAY is 2026-11-11, today, yesterday or an ISO time (both ends
                                        included); --meeting is a Meet code (the same recurring meeting); --with is
                                        anyone a call names from Meet's speaking ring; --calls also prints who
  polycap search WORDS... [the same filters]
                                        transcript lines, titles and summaries holding every word (any case or accent),
                                        with their clocks and speakers; hosted recordings after polycap sync
  polycap transcript <id> [--from T] [--to T]
  polycap frames <id> [--at T --window S] [--from T] [--to T]
                                        print frame paths; T is mm:ss, h:mm:ss, 83 or 1m23s
  polycap frames <id> --at T --exact [--width 1920]
                                        one full-resolution frame at exactly T, from the local video or the receiver
  polycap video <id>                     the original recording, fetched from the receiver if it is not here
  polycap export <id> video|audio|transcript [--sound both|app|mic|mix|none|N] [--from T] [--to T]
                 [--format md|txt|srt|vtt|json] [--out FILE|DIR]
                                        cut a piece out: e.g. video --sound app for a clip without narration,
                                        audio --sound mic for the narration, transcript --format srt for subtitles;
                                        to <root>/exports/<id>/ unless --out
  polycap install-skill [--force]        link skill/ into ~/.claude/skills/polydance-capture
  polycap sync [--video] [--dry-run]     download finished bundles from the hosted receiver (POLYCAP_REMOTE_URL)
  polycap serve [--host H] [--port P]    run the hosted receiver: uploads in, bundles out (POLYCAP_SERVER_TOKENS)
  polycap token new --id NAME --member|--team [--scope upload|read|post ...] [--project KEY ...] [--user ID] [--label TEXT] [--expires 90d|DATE|never] [--save NAME]
                                        make a receiver token; prints it once and the line for the server;
                                        --member: reaches only threads its --user is a member of (someone outside the team)

Threads (docs/THREADS.md): every recording is in one; the team posts messages whose launches the headset runs.
  polycap project list [--capabilities]  the projects your token sees, yours and the team's; with what the receiver offers
  polycap project new NAME [--key KEY] [--host H ...] [--package P ...]
                                         a project of your own, which only you see whole
  polycap project edit KEY [--add-host H ...] [--remove-host H ...] [--add-package P ...] [--remove-package P ...]
                                         what the launches of a project of your own may open; alone, prints it
  polycap connect CODE [--url URL] [--label "Mac"] [--save NAME] [--replace]
                                         connect this machine's agent to your own threads and recordings: CODE is
                                         from Connect your agent in Polydance on your headset. The token goes into
                                         ~/.config/polycap/env (never printed), or with --save into a file for one
                                         repository (polycap link KEY --token NAME); it expires after 90 days
  polycap disconnect [--token NAME]       give that token up: the receiver forgets it and it leaves this machine
  polycap link KEY [--token NAME]        write .polycap.json at this repository's root (commit it); --token names
                                        this repository's agent token, saved with polycap token new --save NAME
  polycap thread list [--all] [--closed] [--project KEY] [--reports]
                                        --reports: only reports from the headset's bug key (team tokens see them)
  polycap thread show REF                every message, recordings with their sessions; saves its photos into the
                                        library and prints their paths; marks it read
  polycap thread new --title T [--text X | --text-file F] [--photo FILE ...] [--as NAME] [launch]
  polycap thread reply REF [--text X | --text-file F] [--photo FILE ...] [--as NAME] [launch]
        --photo: up to ten, JPEG or PNG (HEIC and others converted with ffmpeg), turned upright, scaled to 4096 px
                and stripped of location and every other tag before they are sent
        --as: what an agent calls itself ("Opus 5.5"), so the message reads "Opus 5.5 on Robin's Mac" (or POLYCAP_AS)
        launch: [--open URL] [--app PKG [--activity A] [--data URI] [--extra K=V ...]] [--model FILE.glb] [--require PKG[@CODE|@NAME] ...]
                [--label L], or --launch FILE.json ... for several
        --model: pushes the .glb to the receiver; Reply on the headset records and opens it in Polydance's 3D viewer panel
        options: --option NAME [launch flags] --option NAME [launch flags] ...: up to six, each with its own
                START and a star the tester can pick; launch flags before the first --option are shared
  polycap thread react REF MESSAGE heart|thumbs-up|thumbs-down|haha|emphasis|question
  polycap thread close|reopen REF  ·  polycap thread rename REF TITLE
  polycap thread add|remove REF --person ID [--person ID ...] [--history hidden|visible]
                                        the team adds someone to a thread, or takes them out, by person id: a user in
                                        POLYCAP_USERS (testers mapped to one included), or a tester's own meta-…/google-… id;
                                        --history visible lets them see what came before (else the receiver's default)
  polycap thread invite|uninvite REF --email ADDRESS [--email ADDRESS ...] [--resend | --history hidden|visible]
                                        copy an address into a thread, or take it out: the team's additions are emailed
                                        who added them and the thread's title, with how to join (POLYCAP_MAIL);
                                        --resend sends a failed invitation again
  polycap me [--email ADDRESS | --clear] this token's person and own address; --email sets it as the headset's account
                                        sheet does, and the receiver emails a link to confirm it
  polycap thread welcome --person ID [--again]
                                        the team opens someone's Welcome thread (POLYCAP_WELCOME): signing in opens
                                        it by itself; this is for anyone who signed in before, or to try it yourself
  polycap thread watch [REF] [--once] [--kind K ...] [--timeout 2h] [--after ID] [--all]
                                        print events by others; --once returns on the first (exit 1 on timeout);
                                        --kind recording.ready waits for the tester's reply to be built
  polycap thread pending [--project KEY] [--all]
                                        threads with recordings or picks your token has not read (exit 1 when none)
  REF is a key such as MUS-12, or a number in the linked project.

Global: --root DIR (or POLYCAP_ROOT), --json. Settings: ~/.config/polycap/env (chmod 600) or the environment; see .env.example.`;

/** The filters `list` and `search` share (find.ts). */
const FIND_OPTIONS = {
  calls: { type: 'boolean' }, walkthroughs: { type: 'boolean' }, since: { type: 'string' }, until: { type: 'string' },
  meeting: { type: 'string' }, with: { type: 'string' }, thread: { type: 'string' }, limit: { type: 'string' },
} as const;
const findOptions = (v: { calls?: boolean; walkthroughs?: boolean; since?: string; until?: string; meeting?: string; with?: string; thread?: string; limit?: string }): FindOptions =>
  ({ calls: v.calls, walkthroughs: v.walkthroughs, since: v.since, until: v.until, meeting: v.meeting, with: v.with, thread: v.thread, limit: v.limit });

/** --history on thread add and invite: whether the people added see what came before. */
function historyChoice(value: string): 'hidden' | 'visible' {
  if (value !== 'hidden' && value !== 'visible') throw new UserError(`--history is hidden or visible, not ${value}`);
  return value;
}

function parse<T extends Record<string, { type: 'string' | 'boolean'; short?: string; multiple?: boolean; default?: string | boolean | string[] }>>(args: string[], options: T) {
  try { return parseArgs({ args, options: { ...options, root: { type: 'string' }, json: { type: 'boolean' } }, allowPositionals: true, strict: true, tokens: true }); }
  catch (error) { throw new UserError(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`); }
}

export async function main(argv: string[]): Promise<number> {
  const [command = 'help', ...rest] = argv;
  if (['help', '--help', '-h'].includes(command)) { console.log(USAGE); return 0; }
  if (['--version', '-v', 'version'].includes(command)) { console.log(TOOL_VERSION); return 0; }
  const env = { ...readEnvFile(userConfigFile()), ...process.env };
  const makeCli = (values: { root?: string; json?: boolean }): Cli => {
    const problem = legacySetup(values.root ? { ...env, POLYCAP_ROOT: values.root } : env);
    if (problem) throw new UserError(problem);
    return {
      config: loadConfig(env, values.root ? { root: values.root } : {}), json: Boolean(values.json),
      print: line => console.log(line), warn: line => console.error(`warning: ${line}`),
    };
  };
  switch (command) {
    case 'doctor': { const { values } = parse(rest, {}); return await doctor(makeCli(values)) ? 0 : 1; }
    case 'devices': { const { values } = parse(rest, {}); await devices(makeCli(values)); return 0; }
    case 'pull': {
      const { values } = parse(rest, { device: { type: 'string' }, wait: { type: 'boolean', default: true }, 'no-wait': { type: 'boolean' }, 'dry-run': { type: 'boolean' }, folder: { type: 'string', multiple: true } });
      await pull(makeCli(values), { device: values.device, wait: !values['no-wait'], dryRun: Boolean(values['dry-run']), folders: values.folder?.length ? values.folder : undefined });
      return 0;
    }
    case 'import': {
      const { values, positionals } = parse(rest, { app: { type: 'string' }, 'recorded-at': { type: 'string' }, meta: { type: 'string' }, tracks: { type: 'string' } });
      if (positionals.length !== 1) throw new UserError('import needs exactly one video path');
      await importRecording(makeCli(values), positionals[0], { app: values.app, recordedAt: values['recorded-at'], meta: values.meta, tracks: values.tracks });
      return 0;
    }
    case 'process': {
      const { values, positionals } = parse(rest, { force: { type: 'boolean' }, step: { type: 'string' }, all: { type: 'boolean' }, 'no-hooks': { type: 'boolean' } });
      await processCommand(makeCli(values), { refs: positionals, all: Boolean(values.all), force: Boolean(values.force), step: values.step, hooks: !values['no-hooks'] });
      return 0;
    }
    case 'run': {
      const { values } = parse(rest, { device: { type: 'string' }, 'no-wait': { type: 'boolean' }, 'no-hooks': { type: 'boolean' } });
      const cli = makeCli(values);
      await pull(cli, { device: values.device, wait: !values['no-wait'], dryRun: false });
      await processCommand(cli, { refs: [], all: false, force: false, hooks: !values['no-hooks'] });
      return 0;
    }
    case 'hooks': {
      const [sub, ...args] = rest;
      if (sub === 'list') { const { values } = parse(args, {}); await hooksList(makeCli(values)); return 0; }
      if (sub === 'run') {
        const { values, positionals } = parse(args, { hook: { type: 'string' }, force: { type: 'boolean' } });
        if (positionals.length !== 1) throw new UserError('Usage: polycap hooks run <id> [--hook NAME] [--force]');
        await hooksRun(makeCli(values), positionals[0], { hook: values.hook, force: Boolean(values.force) }); return 0;
      }
      throw new UserError('Usage: polycap hooks list | polycap hooks run <id> [--hook NAME] [--force]');
    }
    case 'upload': {
      const { values, positionals } = parse(rest, { thread: { type: 'string' }, project: { type: 'string' }, report: { type: 'boolean' }, 'reply-to': { type: 'string' }, launch: { type: 'string' }, meta: { type: 'string' }, tracks: { type: 'string' }, token: { type: 'string' }, 'no-narration': { type: 'boolean' } });
      if (positionals.length !== 1) throw new UserError('Usage: polycap upload <video> --thread KEY [--reply-to N [--launch L]] | --project KEY | --report [--meta FILE.meta.json]');
      await upload(makeCli(values), positionals[0], { thread: values.thread, project: values.project, report: values.report, replyTo: values['reply-to'], launch: values.launch, meta: values.meta, tracks: values.tracks, token: values.token, narration: !values['no-narration'] });
      return 0;
    }
    case 'list': { const { values } = parse(rest, FIND_OPTIONS); await list(makeCli(values), findOptions(values)); return 0; }
    case 'search': {
      const { values, positionals } = parse(rest, FIND_OPTIONS);
      await search(makeCli(values), positionals, findOptions(values)); return 0;
    }
    case 'latest': { const { values } = parse(rest, {}); await latest(makeCli(values)); return 0; }
    case 'show': {
      const { values, positionals } = parse(rest, {});
      await show(makeCli(values), positionals[0] ?? 'latest'); return 0;
    }
    case 'transcript': {
      const { values, positionals } = parse(rest, { from: { type: 'string' }, to: { type: 'string' } });
      await transcript(makeCli(values), positionals[0] ?? 'latest', { from: values.from, to: values.to }); return 0;
    }
    case 'frames': {
      const { values, positionals } = parse(rest, { at: { type: 'string' }, window: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, exact: { type: 'boolean' }, width: { type: 'string' } });
      await frames(makeCli(values), positionals[0] ?? 'latest', { at: values.at, window: values.window, from: values.from, to: values.to, exact: Boolean(values.exact), width: values.width }); return 0;
    }
    case 'video': {
      const { values, positionals } = parse(rest, {});
      await video(makeCli(values), positionals[0] ?? 'latest'); return 0;
    }
    case 'export': {
      const { values, positionals } = parse(rest, { sound: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, format: { type: 'string' }, out: { type: 'string' } });
      if (positionals.length !== 2) throw new UserError(`export needs a session and what to export, e.g. polycap export latest video --sound app\n\n${USAGE}`);
      await exportCommand(makeCli(values), positionals[0], positionals[1], { sound: values.sound, from: values.from, to: values.to, format: values.format, out: values.out }); return 0;
    }
    case 'sync': {
      const { values } = parse(rest, { video: { type: 'boolean' }, 'dry-run': { type: 'boolean' } });
      await sync(makeCli(values), { video: Boolean(values.video), dryRun: Boolean(values['dry-run']) }); return 0;
    }
    case 'serve': {
      const { values } = parse(rest, { host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', default: '8790' } });
      const port = Number(values.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UserError(`--port ${values.port} is not a port`);
      const server = await serve(makeCli(values), {
        host: values.host!, port, tokens: env.POLYCAP_SERVER_TOKENS, projects: env.POLYCAP_PROJECTS, users: env.POLYCAP_USERS, reports: env.POLYCAP_REPORTS, privacyContact: env.POLYCAP_PRIVACY_CONTACT, welcome: env.POLYCAP_WELCOME, join: env.POLYCAP_JOIN, newMemberHistory: env.POLYCAP_NEW_MEMBER_HISTORY,
        mail: { POLYCAP_MAIL: env.POLYCAP_MAIL, POLYCAP_AHASEND_KEY: env.POLYCAP_AHASEND_KEY, POLYCAP_AHASEND_URL: env.POLYCAP_AHASEND_URL, POLYCAP_PUBLIC_URL: env.POLYCAP_PUBLIC_URL },
        meta: { POLYCAP_META_APP_ID: env.POLYCAP_META_APP_ID, POLYCAP_META_APP_SECRET: env.POLYCAP_META_APP_SECRET, POLYCAP_META_TESTERS: env.POLYCAP_META_TESTERS, POLYCAP_META_GRAPH_URL: env.POLYCAP_META_GRAPH_URL },
        google: { POLYCAP_GOOGLE_CLIENT_ID: env.POLYCAP_GOOGLE_CLIENT_ID, POLYCAP_GOOGLE_TESTERS: env.POLYCAP_GOOGLE_TESTERS, POLYCAP_GOOGLE_CERTS_URL: env.POLYCAP_GOOGLE_CERTS_URL },
      });
      // Stop taking requests, then let the current bundle finish; a second signal exits at once.
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void server.close().then(() => process.exit(0)); process.once(signal, () => process.exit(1)); });
      await new Promise(() => {});
      return 0;
    }
    case 'token': {
      const [sub, ...args] = rest;
      if (sub !== 'new') throw new UserError('Usage: polycap token new --id NAME --member|--team [--scope upload|read|post ...] [--project KEY ...] [--user ID] [--label TEXT] [--expires 90d|DATE|never] [--save NAME]');
      const { values } = parse(args, { id: { type: 'string' }, scope: { type: 'string', multiple: true }, project: { type: 'string', multiple: true }, label: { type: 'string' }, user: { type: 'string' }, member: { type: 'boolean' }, team: { type: 'boolean' }, expires: { type: 'string' }, save: { type: 'string' } });
      if (!values.id) throw new UserError('--id is required, for example --id quest3');
      await tokenNew(makeCli(values), { id: values.id, scopes: values.scope ?? [], projects: values.project ?? [], label: values.label, user: values.user, member: Boolean(values.member), team: Boolean(values.team), expires: values.expires, save: values.save }); return 0;
    }
    case 'project': {
      const [sub, ...args] = rest;
      if (sub === 'new') {
        const { values, positionals } = parse(args, { key: { type: 'string' }, host: { type: 'string', multiple: true }, package: { type: 'string', multiple: true } });
        await projectNew(makeCli(values), (() => { if (positionals.length !== 1) throw new UserError('Usage: polycap project new NAME [--key KEY] [--host H ...] [--package P ...]; quote a name with spaces'); return positionals[0]; })(), { key: values.key, hosts: values.host ?? [], packages: values.package ?? [] }); return 0;
      }
      if (sub === 'edit') {
        const { values, positionals } = parse(args, { 'add-host': { type: 'string', multiple: true }, 'remove-host': { type: 'string', multiple: true }, 'add-package': { type: 'string', multiple: true }, 'remove-package': { type: 'string', multiple: true } });
        if (positionals.length !== 1) throw new UserError('Usage: polycap project edit KEY [--add-host H ...] [--remove-host H ...] [--add-package P ...] [--remove-package P ...]');
        await projectEdit(makeCli(values), positionals[0], { addHosts: values['add-host'], removeHosts: values['remove-host'], addPackages: values['add-package'], removePackages: values['remove-package'] }); return 0;
      }
      if (sub !== 'list') throw new UserError('Usage: polycap project list | polycap project new NAME [--key KEY] [--host H ...] [--package P ...] | polycap project edit KEY [--add-host H ...]');
      const { values } = parse(args, { capabilities: { type: 'boolean' } });
      await projectList(makeCli(values), { capabilities: Boolean(values.capabilities) }); return 0;
    }
    case 'connect': {
      const { values, positionals } = parse(rest, { url: { type: 'string' }, label: { type: 'string' }, save: { type: 'string' }, replace: { type: 'boolean' } });
      if (positionals.length !== 1) throw new UserError('Usage: polycap connect CODE [--url URL] [--label "Mac"] [--save NAME] [--replace]; CODE is from Connect your agent in Polydance on your headset');
      await connect(makeCli(values), positionals[0], { url: values.url, label: values.label, save: values.save, replace: Boolean(values.replace) }); return 0;
    }
    case 'disconnect': {
      const { values, positionals } = parse(rest, { token: { type: 'string' } });
      if (positionals.length) throw new UserError('Usage: polycap disconnect [--token NAME]');
      await disconnect(makeCli(values), { token: values.token }); return 0;
    }
    case 'link': {
      const { values, positionals } = parse(rest, { token: { type: 'string' } });
      if (positionals.length !== 1) throw new UserError('Usage: polycap link KEY [--token NAME], for example polycap link MUS');
      await link(makeCli(values), positionals[0], process.cwd(), values.token); return 0;
    }
    case 'thread': return thread(rest, makeCli);
    case 'me': {
      const { values, positionals } = parse(rest, { email: { type: 'string' }, clear: { type: 'boolean' } });
      if (positionals.length || (values.email !== undefined && values.clear)) throw new UserError('Usage: polycap me [--email ADDRESS | --clear]');
      await me(makeCli(values), values.clear ? { email: null } : values.email !== undefined ? { email: values.email } : {}); return 0;
    }
    case 'runner': throw new UserError('The local router (polycap runner) was removed on 2026-10-12. Post with polycap thread reply, then wait in the conversation with polycap thread watch REF --once --kind recording.ready.');
    case 'install-skill': { const { values } = parse(rest, { force: { type: 'boolean' } }); await installSkill(makeCli(values), { force: Boolean(values.force) }); return 0; }
    default: throw new UserError(`Unknown command "${command}"\n\n${USAGE}`);
  }
}

const launchOptions = {
  open: { type: 'string' }, app: { type: 'string' }, activity: { type: 'string' }, data: { type: 'string' }, extra: { type: 'string', multiple: true }, model: { type: 'string' },
  require: { type: 'string', multiple: true }, label: { type: 'string' }, launch: { type: 'string', multiple: true }, option: { type: 'string', multiple: true },
  text: { type: 'string' }, 'text-file': { type: 'string' }, project: { type: 'string' }, as: { type: 'string' }, photo: { type: 'string', multiple: true },
} as const;

const LAUNCH_FLAGS = new Set(['open', 'app', 'activity', 'data', 'extra', 'require', 'model']);

/**
 * Options in the order the flags were given: each --option starts one, the launch flags after it are its
 * own, and those before the first --option are shared by all, so `--require PKG@231 --option A --app PKG
 * --extra variant=a --option B --app PKG --extra variant=b` is two options needing build 231 (2026-10-06).
 */
function optionGroups(tokens: ReturnType<typeof parseArgs>['tokens']): OptionGroups | undefined {
  const shared: LaunchFlags = {};
  const options: OptionGroups['options'] = [];
  for (const token of tokens ?? []) {
    if (token.kind !== 'option') continue;
    if (token.name === 'option') { options.push({ label: token.value ?? '' }); continue; }
    if (!LAUNCH_FLAGS.has(token.name) || token.value === undefined) continue;
    const into = options.at(-1) ?? shared;
    if (token.name === 'extra' || token.name === 'require') (into[token.name] ??= []).push(token.value);
    else into[token.name as 'open' | 'app' | 'activity' | 'data' | 'model'] = token.value;
  }
  return options.length ? { shared, options } : undefined;
}

/** `thread new` and `reply`'s launch arguments, options grouped in order; exported for the tests. */
export function launchArgs(args: string[]) {
  const { values, positionals, tokens } = parse(args, { ...launchOptions, title: { type: 'string' } });
  return { values, positionals, optionGroups: optionGroups(tokens) };
}

async function thread(rest: string[], makeCli: (values: { root?: string; json?: boolean }) => Cli): Promise<number> {
  const [sub, ...args] = rest;
  const one = (positionals: string[], what: string) => {
    if (positionals.length !== 1) throw new UserError(`Usage: polycap thread ${sub} ${what}`);
    return positionals[0];
  };
  switch (sub) {
    case 'list': {
      const { values } = parse(args, { project: { type: 'string' }, all: { type: 'boolean' }, closed: { type: 'boolean' }, reports: { type: 'boolean' } });
      await threadList(makeCli(values), { project: values.project, all: Boolean(values.all), closed: Boolean(values.closed), reports: Boolean(values.reports) }); return 0;
    }
    case 'show': {
      const { values, positionals } = parse(args, { project: { type: 'string' } });
      await threadShow(makeCli(values), one(positionals, 'REF'), { project: values.project }); return 0;
    }
    case 'new': {
      const { values, tokens } = parse(args, { ...launchOptions, title: { type: 'string' } });
      await threadNew(makeCli(values), values.title, { ...values, textFile: values['text-file'], optionGroups: optionGroups(tokens) }); return 0;
    }
    case 'reply': {
      const { values, positionals, tokens } = parse(args, launchOptions);
      await threadReply(makeCli(values), one(positionals, 'REF [--text X] [launch]'), { ...values, textFile: values['text-file'], optionGroups: optionGroups(tokens) }); return 0;
    }
    case 'react': {
      const { values, positionals } = parse(args, { project: { type: 'string' } });
      if (positionals.length !== 3) throw new UserError('Usage: polycap thread react REF MESSAGE REACTION, for example polycap thread react MUS-12 3 thumbs-up');
      await threadReact(makeCli(values), positionals[0], positionals[1], positionals[2], { project: values.project }); return 0;
    }
    case 'close': case 'reopen': {
      const { values, positionals } = parse(args, { project: { type: 'string' } });
      await threadUpdate(makeCli(values), one(positionals, 'REF'), { state: sub === 'close' ? 'closed' : 'open' }, { project: values.project }); return 0;
    }
    case 'rename': {
      const { values, positionals } = parse(args, { project: { type: 'string' } });
      if (positionals.length < 2) throw new UserError('Usage: polycap thread rename REF TITLE');
      await threadUpdate(makeCli(values), positionals[0], { title: positionals.slice(1).join(' ') }, { project: values.project }); return 0;
    }
    case 'add': case 'remove': {
      const { values, positionals } = parse(args, { project: { type: 'string' }, person: { type: 'string', multiple: true }, history: { type: 'string' } });
      if (positionals.length !== 1 || !values.person?.length || (sub === 'remove' && values.history)) throw new UserError(`Usage: polycap thread ${sub} REF --person ID [--person ID ...]${sub === 'add' ? ' [--history hidden|visible]' : ''}, for example polycap thread ${sub} MUS-12 --person ana`);
      await threadMembers(makeCli(values), positionals[0], { [sub]: values.person, ...(values.history ? { history: historyChoice(values.history) } : {}) }, { project: values.project }); return 0;
    }
    case 'invite': case 'uninvite': {
      const { values, positionals } = parse(args, { project: { type: 'string' }, email: { type: 'string', multiple: true }, resend: { type: 'boolean' }, history: { type: 'string' } });
      if (positionals.length !== 1 || !values.email?.length || (sub === 'uninvite' && values.resend) || (values.history && (sub === 'uninvite' || values.resend))) throw new UserError(`Usage: polycap thread ${sub} REF --email ADDRESS [--email ADDRESS ...]${sub === 'invite' ? ' [--resend | --history hidden|visible]' : ''}, for example polycap thread ${sub} MUS-12 --email ana@example.com`);
      const change = sub === 'uninvite' ? { remove: values.email } : values.resend ? { resend: values.email } : { add: values.email, ...(values.history ? { history: historyChoice(values.history) } : {}) };
      await threadInvite(makeCli(values), positionals[0], change, { project: values.project }); return 0;
    }
    case 'welcome': {
      const { values, positionals } = parse(args, { person: { type: 'string' }, again: { type: 'boolean' } });
      if (positionals.length || !values.person) throw new UserError('Usage: polycap thread welcome --person ID [--again], for example polycap thread welcome --person robin');
      await threadWelcome(makeCli(values), values.person, { again: Boolean(values.again) }); return 0;
    }
    case 'pending': {
      const { values } = parse(args, { project: { type: 'string' }, all: { type: 'boolean' } });
      const pending = await threadPending(makeCli(values), { project: values.project, all: Boolean(values.all) });
      return pending.length ? 0 : 1;
    }
    case 'watch': {
      const { values, positionals } = parse(args, { project: { type: 'string' }, all: { type: 'boolean' }, once: { type: 'boolean' }, after: { type: 'string' }, timeout: { type: 'string' }, kind: { type: 'string', multiple: true } });
      if (positionals.length > 1) throw new UserError('Usage: polycap thread watch [REF] [--once] [--kind recording.ready] [--timeout 2h]');
      const event = await threadWatch(makeCli(values), positionals[0], { project: values.project, all: Boolean(values.all), once: Boolean(values.once), after: values.after, timeout: values.timeout, kinds: values.kind });
      return values.once && !event ? 1 : 0;
    }
    default: throw new UserError(`Unknown thread command "${sub ?? ''}": list, show, new, reply, react, close, reopen, rename, add, remove, pending or watch\n\n${USAGE}`);
  }
}

const invokedDirectly = process.argv[1] && /(?:^|\/)cli\.ts$|(?:^|\/)polycap(?:\.js)?$/.test(process.argv[1]);
if (invokedDirectly) {
  // `polycap show … | head` closes the pipe early: the reader is done, which is not an error.
  process.stdout.on('error', error => { if ((error as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0); throw error; });
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    if (error instanceof UserError) { console.error(error.message); process.exitCode = error.exitCode; }
    else if (error instanceof ToolError) { console.error(error.message); process.exitCode = 3; }
    else { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; }
  });
}
