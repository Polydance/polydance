/**
 * Threads from the agent's side (docs/THREADS.md): `polycap project list`, `polycap link` and
 * `polycap thread …`. A repository names its project in .polycap.json, written by `link` and committed,
 * so a bare number means a thread in that project and lists default to it. `show` marks the thread read
 * for this token. `watch` prints events as they happen; with --once it returns on the first one by
 * someone else, which is how an agent waits for the tester's reply. `new` and `reply` send --photo files
 * first and `show` saves the photos it may see into the library (thread-photos.ts).
 */
import { createHash } from 'node:crypto';
import { stat, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { UserError } from '../errors.js';
import { inspectGlb, MODEL_MAX_BYTES, modelNameSchema } from '../glb.js';
import { exists, sleep } from '../fsx.js';
import { userConfigFile } from '../config.js';
import { TOKEN_PATTERN } from '../server/tokens.js';
import { agentNameSchema, describeLaunch, editProjectSchema, launchSchema, newProjectSchema, projectKeySchema, reactionName, REACTION_NAMES, REACTIONS, threadKey, USER_ID, type Launch, type LaunchStep, launchesSchema, megabytes, type ModelStep } from '../threads.js';
import { formatClock, parseClock } from '../time.js';
import { EVENT_KINDS } from '../server/threads.js';
import type { Cli } from './context.js';
import { table } from './context.js';
import { remote, RemoteError, type Remote } from './remote.js';
import { pushPhotos, savePhotos } from './thread-photos.js';
import { photoSchema } from '../photo.js';

export const LINK_FILE = '.polycap.json';
/** A repository's project, and optionally the name of its own agent token in ~/.config/polycap/tokens/. */
const linkSchema = z.strictObject({ project: projectKeySchema, token: z.string().regex(USER_ID, 'a token name is lowercase letters, digits and dashes').optional() });

const author = z.looseObject({ id: z.string(), name: z.string(), display: z.string().optional() });
/** "Opus 5.5 on Robin's Mac", or the label for messages written before names. */
const who = (by: z.infer<typeof author>) => by.display ?? by.name;
const projectsSchema = z.looseObject({ me: z.string(), projects: z.array(z.looseObject({ key: z.string(), name: z.string(), mine: z.boolean().optional() })) });
const madeSchema = z.looseObject({ project: z.looseObject({ key: z.string(), name: z.string(), hosts: z.array(z.string()), packages: z.array(z.string()) }) });
const summarySchema = z.looseObject({
  key: z.string(), project: z.string(), title: z.string(), state: z.string(), updatedAt: z.string(), messages: z.number(), unread: z.boolean(), waiting: z.boolean(),
  /** Recordings by others, words or bundle ready, this token has not seen (receivers before 2026-10-04 do not send it). */
  fresh: z.number().default(0),
  /** Opened by a report from the headset's bug key (receivers from 2026-10-12). */
  report: z.boolean().default(false),
  last: z.looseObject({ kind: z.string(), by: author, at: z.string(), text: z.string() }),
});
const listSchema = z.looseObject({ me: z.string(), unread: z.number(), threads: z.array(summarySchema) });
const messageView = z.looseObject({
  id: z.number(), at: z.string(), by: author, text: z.string().optional(), launches: z.array(launchSchema).optional(),
  recording: z.looseObject({
    uploadId: z.string(), status: z.string().optional(), sessionId: z.string().optional(), title: z.string().optional(), summary: z.string().optional(),
    durationMs: z.number().optional(), error: z.string().optional(), replyTo: z.looseObject({ message: z.number(), launch: z.number().optional() }).optional(),
    /** The answered message's options this recording put on screen (receivers from 2026-10-06). */
    tried: z.array(z.number()).default([]),
    /** A picture, sound alone, or nothing (logs alone), and whether the take sent the headset's log (receivers from 2026-11-16, docs/LOGS.md). */
    // A string, not an enum: a kind a later receiver adds must not stop a thread from showing; it reads as a recording.
    content: z.string().optional(), logs: z.boolean().optional(),
  }).optional(),
  reactions: z.array(z.looseObject({ reaction: z.enum(REACTION_NAMES), by: author })).default([]),
  picks: z.array(z.looseObject({ launch: z.number(), by: author })).default([]),
  /** Photos (receivers from 2026-11-07), and whether this token may see them. */
  photos: z.array(photoSchema).optional(), canView: z.boolean().optional(),
});
const threadSchema = z.looseObject({
  me: z.string(), key: z.string(), project: z.looseObject({ key: z.string(), name: z.string() }), title: z.string(), state: z.string(),
  seq: z.number(), messages: z.array(messageView), report: z.boolean().default(false),
  /** People the team added (receivers from 2026-10-21, team tokens only). */
  members: z.array(z.looseObject({ person: z.string(), name: z.string() })).optional(),
  /** Addresses copied in, shown to members, with whether each was emailed (receivers from 2026-11-10 say why not). */
  participants: z.array(z.looseObject({ email: z.string(), emailed: z.boolean().optional(), emailNote: z.string().optional() })).optional(),
});
const eventSchema = z.looseObject({
  id: z.number(), at: z.string(), kind: z.string(), thread: z.string(), project: z.string(), by: author, message: z.number().optional(),
  reaction: z.string().nullable().optional(), sessionId: z.string().optional(), title: z.string().optional(), summary: z.string().optional(), error: z.string().optional(),
  photos: z.number().optional(),
});
type ThreadEvent = z.infer<typeof eventSchema>;
const eventsSchema = z.looseObject({ me: z.string(), events: z.array(eventSchema), last: z.number() });

/** Where saved agent tokens live: beside the settings file, one private file per token. */
export const tokensDir = () => join(dirname(userConfigFile()), 'tokens');

/**
 * The receiver as this repository's agent: with the token .polycap.json names (2026-10-04: one token per
 * agent, so its messages say which agent and its reach is one project), else this machine's token.
 */
async function server(cli: Cli, cwd: string): Promise<Remote> {
  const name = (await findLink(cwd))?.token;
  if (!name) return remote(cli.config);
  const file = join(tokensDir(), name);
  const info = await stat(file).catch(() => undefined);
  if (!info) throw new UserError(`.polycap.json names token "${name}", but ${file} does not exist; make it with polycap token new --save ${name}`);
  if (info.mode & 0o077) throw new UserError(`${file} is readable by other users; run chmod 600 ${file}`);
  const token = (await readFile(file, 'utf8')).trim();
  if (!TOKEN_PATTERN.test(token)) throw new UserError(`${file} does not hold a receiver token`);
  return remote({ ...cli.config, remoteToken: token });
}

/** The nearest .polycap.json above `from`, as written by `polycap link`. */
export async function findLink(from = process.cwd()): Promise<{ file: string; project: string; token?: string } | undefined> {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const file = join(dir, LINK_FILE);
    if (await exists(file)) {
      let json: unknown;
      try { json = JSON.parse(await readFile(file, 'utf8')); } catch { throw new UserError(`${file} is not JSON; it should be {"project": "MUS"}`); }
      const parsed = linkSchema.safeParse(json);
      if (!parsed.success) throw new UserError(`${file} should be {"project": "MUS"}: ${parsed.error.issues.map(i => i.message).join('; ')}`);
      return { file, project: parsed.data.project, ...(parsed.data.token ? { token: parsed.data.token } : {}) };
    }
    if (dirname(dir) === dir) return undefined;
  }
}

const serverFor = (cli: Cli, cwd?: string) => server(cli, cwd ?? process.cwd());

/** --project, else the repository's link, else the token's only project. */
async function projectFor(server: Remote, explicit: string | undefined, cwd: string): Promise<string | undefined> {
  if (explicit) return projectKeySchema.parse(explicit.toUpperCase());
  const link = await findLink(cwd);
  if (link) return link.project;
  const { projects } = await server.json('GET', '/v1/projects', projectsSchema);
  return projects.length === 1 ? projects[0].key : undefined;
}

const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`;
};
const when = (iso: string) => {
  const d = new Date(iso);
  return `${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * The projects this token sees. With `capabilities`, also what the receiver offers (reports-v1: it takes reports
 * from the bug key; projects-new-v1: it makes projects of your own), as `{ projects, capabilities }` in JSON:
 * the Mac app reads it to offer Report and New project only where they work.
 */
export async function projectList(cli: Cli, options: { capabilities?: boolean } = {}): Promise<void> {
  const { projects, capabilities } = await remote(cli.config).json('GET', '/v1/projects', projectsSchema.extend({ capabilities: z.array(z.string()).default([]) }));
  if (cli.json) { cli.print(JSON.stringify(options.capabilities ? { projects, capabilities } : projects)); return; }
  if (options.capabilities) cli.print(`This receiver ${capabilities.includes('reports-v1') ? 'takes reports' : 'takes no reports'} and ${capabilities.includes('projects-new-v1') ? 'makes projects of your own' : 'makes no projects of your own'}.`);
  // An agent someone connected themselves sees no team project (2026-11-20), so none is its usual start, not a fault.
  const none = capabilities.includes('projects-new-v1')
    ? 'This token sees no projects yet. Make one of your own: polycap project new "Name" --host your.preview.host'
    : 'This token sees no projects; threads may be off on the receiver (POLYCAP_PROJECTS).';
  cli.print(projects.length ? table(projects.map(p => [p.key, p.name, p.mine ? 'yours' : 'team']), ['key', 'project', 'whose']) : none);
}

/**
 * Makes a project of your own on the receiver (2026-11-13, docs/THREADS.md "Projects of your own"): only your
 * person sees it whole. The receiver checks the name, key and hosts; this checks them first so a typo fails here.
 */
export async function projectNew(cli: Cli, name: string, options: { key?: string; hosts: string[]; packages: string[] }): Promise<string> {
  const parsed = newProjectSchema.safeParse({ name, ...(options.key ? { key: options.key } : {}), ...(options.hosts.length ? { hosts: options.hosts } : {}), ...(options.packages.length ? { packages: options.packages } : {}) });
  if (!parsed.success) throw new UserError(parsed.error.issues.map(i => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`).join('; '));
  const server = remote(cli.config);
  const { capabilities } = await server.json('GET', '/v1/projects', z.looseObject({ capabilities: z.array(z.string()).default([]) }));
  if (!capabilities.includes('projects-new-v1')) throw new UserError('this receiver does not make projects yet: it is older than 2026-11-13, or threads are off');
  const { project } = await server.json('POST', '/v1/projects', madeSchema, parsed.data);
  cli.print(cli.json ? JSON.stringify(project) : `${project.key}: ${project.name}, yours.${project.hosts.length || project.packages.length ? ` Launches may open ${[...project.hosts, ...project.packages].join(', ')}.` : ' It has no hosts or packages, so its messages carry no launches yet.'} Link a repository to it with polycap link ${project.key}.`);
  return project.key;
}

/**
 * Shows, or changes, what the launches of a project of your own may open (2026-11-20): a project made in the
 * headset has a name and nothing else, and its previews' host is often known only later. The receiver takes the
 * whole new lists, so this reads them, adds and removes, and sends the result. With nothing to change it prints them.
 */
export async function projectEdit(cli: Cli, key: string, change: { addHosts?: string[]; removeHosts?: string[]; addPackages?: string[]; removePackages?: string[] }, options: { cwd?: string } = {}): Promise<void> {
  const parsedKey = projectKeySchema.safeParse(key.toUpperCase());
  if (!parsedKey.success) throw new UserError(`${key} is not a project key such as MUS`);
  const server = await serverFor(cli, options.cwd);
  const { capabilities } = await server.json('GET', '/v1/projects', z.looseObject({ capabilities: z.array(z.string()).default([]) }));
  if (!capabilities.includes('projects-edit-v1')) throw new UserError('this receiver does not change projects yet: it is older than 2026-11-20, or threads are off');
  const { project } = await server.json('GET', `/v1/projects/${parsedKey.data}`, madeSchema);
  const next = (have: string[], add: string[] = [], remove: string[] = [], what: string) => {
    const missing = remove.filter(item => !have.includes(item));
    if (missing.length) throw new UserError(`${missing.join(', ')}: not one of ${project.key}'s ${what} (${have.join(', ') || 'none'})`);
    return [...have.filter(item => !remove.includes(item)), ...add.filter((item, i) => !have.includes(item) && add.indexOf(item) === i)];
  };
  const hosts = next(project.hosts, change.addHosts?.map(h => h.trim().toLowerCase()), change.removeHosts?.map(h => h.trim().toLowerCase()), 'hosts');
  const packages = next(project.packages, change.addPackages, change.removePackages, 'packages');
  const describe = (p: { key: string; name: string; hosts: string[]; packages: string[] }) =>
    `${p.key}: ${p.name}. Launches may open hosts ${p.hosts.join(', ') || 'none'}; packages ${p.packages.join(', ') || 'none'}.`;
  const changed = hosts.join('\n') !== project.hosts.join('\n') || packages.join('\n') !== project.packages.join('\n');
  if (!changed) { cli.print(cli.json ? JSON.stringify(project) : describe(project)); return; }
  const parsed = editProjectSchema.safeParse({ hosts, packages });
  if (!parsed.success) throw new UserError(parsed.error.issues.map(i => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`).join('; '));
  const { project: now } = await server.json('POST', `/v1/projects/${parsedKey.data}`, madeSchema, parsed.data);
  cli.print(cli.json ? JSON.stringify(now) : describe(now));
}

/**
 * Writes .polycap.json at the repository root (or here, outside a repository) for a project the token
 * sees, naming the repository's own agent token when one is given.
 */
export async function link(cli: Cli, key: string, cwd = process.cwd(), token?: string): Promise<string> {
  const project = projectKeySchema.parse(key.toUpperCase());
  if (token !== undefined && !USER_ID.test(token)) throw new UserError(`--token ${token}: a token name is lowercase letters, digits and dashes`);
  const { projects } = await remote(cli.config).json('GET', '/v1/projects', projectsSchema);
  const found = projects.find(p => p.key === project);
  if (!found) throw new UserError(`${project} is not a project this token sees (${projects.map(p => p.key).join(', ') || 'none'})`);
  let dir = resolve(cwd);
  for (let probe = dir; ; probe = dirname(probe)) {
    if (await exists(join(probe, '.git'))) { dir = probe; break; }
    if (dirname(probe) === probe) break;
  }
  const file = join(dir, LINK_FILE);
  await writeFile(file, `${JSON.stringify({ project, ...(token ? { token } : {}) }, null, 2)}\n`);
  cli.print(cli.json ? JSON.stringify({ file, project, token }) : `${file}: ${project} (${found.name})${token ? `, as token ${token}` : ''}. Commit it so agents in this repository use it.`);
  return file;
}

/** `reports` lists only the threads opened by reports from the headset's bug key: the team's queue of bugs and feature requests. */
export interface ListOptions { project?: string; all?: boolean; closed?: boolean; reports?: boolean; cwd?: string }

export async function threadList(cli: Cli, options: ListOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const receiver = await server(cli, cwd);
  const project = options.all ? undefined : await projectFor(receiver, options.project, cwd);
  const query = new URLSearchParams({ state: options.closed ? 'closed' : 'open', ...(project ? { project } : {}) });
  const list = await receiver.json('GET', `/v1/threads?${query}`, listSchema);
  const threads = options.reports ? list.threads.filter(t => t.report) : list.threads;
  if (cli.json) { cli.print(JSON.stringify(threads)); return; }
  if (!threads.length) { cli.print(`No ${options.closed ? 'closed' : 'open'} ${options.reports ? 'reports' : 'threads'}${project ? ` in ${project}` : ''}.`); return; }
  cli.print(table(threads.map(t => [t.key, t.title, ago(t.updatedAt), `${who(t.last.by)}: ${t.last.text}`, [t.report ? 'report' : '', t.unread ? 'unread' : ''].filter(Boolean).join(' ')]), ['thread', 'title', 'when', 'last', '']));
}

/**
 * Threads with recordings by others (their words or bundles ready), picks and photo messages that this token has not read: an agent's work. Returns them,
 * so a caller (an agent, a script) can tell "something to do" from "nothing new" by the count.
 */
export async function threadPending(cli: Cli, options: { project?: string; all?: boolean; cwd?: string } = {}): Promise<{ key: string; title: string; fresh: number }[]> {
  const cwd = options.cwd ?? process.cwd();
  const receiver = await server(cli, cwd);
  const project = options.all ? undefined : await projectFor(receiver, options.project, cwd);
  const list = await receiver.json('GET', `/v1/threads${project ? `?project=${project}` : ''}`, listSchema);
  const pending = list.threads.filter(t => t.fresh > 0).map(t => ({ key: t.key, title: t.title, fresh: t.fresh }));
  if (cli.json) cli.print(JSON.stringify(pending));
  else cli.print(pending.length ? table(pending.map(t => [t.key, t.title, `${t.fresh} new (recordings, picks or photos)`]), ['thread', 'title', 'waiting']) : `Nothing new${project ? ` in ${project}` : ''}.`);
  return pending;
}

/** A message's lines; `saved` gives the path of each photo saved into the library, by id. */
function messageLines(message: z.infer<typeof messageView>, saved: ReadonlyMap<string, string> = new Map()): string[] {
  const kind = ({ sound: 'recording (sound only)', none: 'logs only' } as Record<string, string>)[message.recording?.content ?? ''] ?? 'recording';
  const lines = [`#${message.id}  ${when(message.at)}  ${who(message.by)}${message.recording ? `  ${kind}${message.recording.logs && message.recording.content !== 'none' ? ' with logs' : ''}${message.recording.replyTo ? ` (answers #${message.recording.replyTo.message}${message.recording.replyTo.launch !== undefined ? `, launch ${message.recording.replyTo.launch + 1}` : ''})` : ''}` : ''}`];
  if (message.text) lines.push(...message.text.split('\n').map(line => `    ${line}`));
  // Several launches are options; a star says who prefers which (2026-10-06).
  const options = (message.launches?.length ?? 0) > 1;
  message.launches?.forEach((launch, i) => {
    const stars = message.picks.filter(p => p.launch === i).map(p => who(p.by));
    lines.push(`    ${options ? `Option ${i + 1}` : 'Start'}: ${describeLaunch(launch)}${stars.length ? `  ★ ${stars.join(', ')}` : ''}`);
  });
  const photos = message.photos ?? [];
  photos.forEach((photo, i) => {
    const where = message.canView === false ? 'only people in this thread can see it' : saved.get(photo.sha256) ?? 'not saved';
    lines.push(`    photo ${i + 1}${photos.length > 1 ? ` of ${photos.length}` : ''}: ${photo.width}×${photo.height} ${photo.type === 'image/png' ? 'PNG' : 'JPEG'}, ${megabytes(photo.bytes)} → ${where}`);
  });
  const r = message.recording;
  if (r) {
    // Words first: a session while the video is still uploading has its transcript and requests, not its frames.
    const state = r.status === 'uploading' && r.sessionId ? 'words ready, video still uploading' : r.status ?? 'unknown';
    lines.push(`    ${state}${r.sessionId ? ` · session ${r.sessionId}` : ''}${r.durationMs !== undefined ? ` · ${formatClock(r.durationMs)}` : ''}${r.error ? ` · ${r.error}` : ''}`);
    if (r.tried.length) lines.push(`    tried option${r.tried.length > 1 ? 's' : ''} ${r.tried.map(n => n + 1).join(', ')}`);
    if (r.title || r.summary) lines.push(`    ${r.title ? `"${r.title}"` : ''}${r.title && r.summary ? ': ' : ''}${r.summary ?? ''}`);
  }
  if (message.reactions.length) lines.push(`    ${message.reactions.map(x => `${REACTIONS[x.reaction]} ${who(x.by)}`).join('  ')}`);
  return lines;
}

/** Prints a thread and marks it read for this token. */
export async function threadShow(cli: Cli, ref: string, options: { project?: string; cwd?: string } = {}): Promise<void> {
  const server = await serverFor(cli, options.cwd);
  const key = threadKeyFor(ref, await projectFor(server, options.project, options.cwd ?? process.cwd()));
  const thread = await server.json('GET', `/v1/threads/${key}`, threadSchema);
  await server.json('POST', `/v1/threads/${key}/read`, threadSchema, { seq: thread.seq });
  const saved = await savePhotos(cli, server, key, thread.messages);
  if (cli.json) {
    // Each saved photo with its path, for an agent or the Mac app to open.
    const messages = thread.messages.map(m => m.photos ? { ...m, photos: m.photos.map(p => ({ ...p, ...(saved.has(p.sha256) ? { path: saved.get(p.sha256) } : {}) })) } : m);
    cli.print(JSON.stringify({ ...thread, messages }, null, 2));
    return;
  }
  cli.print(`${thread.key} · ${thread.title} · ${thread.project.name} · ${thread.state}${thread.report ? ' · report from the bug key, team only' : ''}`);
  if (thread.members?.length) cli.print(`Members: ${memberNames(thread.members)}`);
  if (thread.participants?.length) cli.print(`Invited by email: ${thread.participants.map(participantLine).join('; ')}`);
  for (const message of thread.messages) { cli.print(''); for (const line of messageLines(message, saved)) cli.print(line); }
  const sessions = thread.messages.flatMap(m => m.recording?.sessionId ? [m.recording.sessionId] : []);
  if (sessions.length) { cli.print(''); cli.print(`Recordings are sessions: polycap sync, then polycap show ${sessions.at(-1)}`); }
}

function threadKeyFor(ref: string, project: string | undefined): string {
  try { return threadKey(ref, project); } catch (error) { throw new UserError((error as Error).message); }
}

/** The flags that make one launch's steps. */
export interface LaunchFlags { open?: string; app?: string; activity?: string; data?: string; extra?: string[]; require?: string[]; model?: string }

/**
 * Options, from the flags in the order given (cli.ts reads them): each --option starts one with its name,
 * the flags after it are its own, and flags before the first --option are shared by every option.
 */
export interface OptionGroups { shared: LaunchFlags; options: (LaunchFlags & { label: string })[] }

export interface LaunchOptions extends LaunchFlags { label?: string; launch?: string[]; optionGroups?: OptionGroups }

/** The --model files' steps once pushed, by the path given; launchFrom reads them from here. */
export type PushedModels = ReadonlyMap<string, ModelStep>;

/** One launch from these flags: version checks first, then what it opens. */
function launchFrom(flags: LaunchFlags, label?: string, models: PushedModels = new Map()): Launch {
  if ((flags.activity || flags.data || flags.extra?.length) && !flags.app) throw new UserError('--activity, --data and --extra go with --app');
  const steps: LaunchStep[] = (flags.require ?? []).map(spec => {
    const [pkg, version] = spec.split('@');
    return { do: 'require', package: pkg, ...(version === undefined ? {} : /^\d+$/.test(version) ? { versionCode: Number(version) } : { versionName: version }) };
  });
  if (flags.open) steps.push({ do: 'open', url: flags.open });
  if (flags.app) {
    const extras = Object.fromEntries((flags.extra ?? []).map(pair => {
      const at = pair.indexOf('=');
      if (at < 1) throw new UserError(`--extra ${pair}: use name=value`);
      return [pair.slice(0, at), pair.slice(at + 1)];
    }));
    steps.push({ do: 'app', package: flags.app, ...(flags.activity ? { activity: flags.activity } : {}), ...(flags.data ? { data: flags.data } : {}), ...(Object.keys(extras).length ? { extras } : {}) });
  }
  if (flags.model) {
    const step = models.get(flags.model);
    if (!step) throw new UserError(`--model ${flags.model} was not pushed to the receiver`);
    steps.push(step);
  }
  const parsed = launchSchema.safeParse({ ...(label ? { label } : {}), steps });
  if (!parsed.success) throw new UserError(`not a launch${label ? ` (${label})` : ''}: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return parsed.data;
}

/** An option's own flags on top of the shared ones: its own link or app wins, extras and checks add up. */
const merged = (shared: LaunchFlags, own: LaunchFlags): LaunchFlags => ({
  open: own.open ?? shared.open, app: own.app ?? shared.app, activity: own.activity ?? shared.activity, data: own.data ?? shared.data, model: own.model ?? shared.model,
  extra: [...shared.extra ?? [], ...own.extra ?? []], require: [...shared.require ?? [], ...own.require ?? []],
});

/** One launch from the flags, one per --option, or one per --launch file; none when nothing is given. */
export async function launchesFrom(options: LaunchOptions, models: PushedModels = new Map()): Promise<Launch[] | undefined> {
  if (options.optionGroups) {
    if (options.launch?.length) throw new UserError('use --option or --launch files, not both');
    if (options.label) throw new UserError('each --option names its own launch; --label is for a single one');
    const launches = options.optionGroups.options.map(option => {
      if (!option.label.trim()) throw new UserError('--option needs a name, for example --option "Red menu"');
      const flags = merged(options.optionGroups!.shared, option);
      if (!flags.open && !flags.app && !flags.model) throw new UserError(`--option "${option.label}" opens nothing: give it --open, --app or --model after it`);
      return launchFrom(flags, option.label.trim(), models);
    });
    const parsed = launchesSchema.safeParse(launches);
    if (!parsed.success) throw new UserError(`options: ${parsed.error.issues.map(i => `${i.path.join('.') || 'list'}: ${i.message}`).join('; ')}`);
    return parsed.data;
  }
  const flags = Boolean(options.open || options.app || options.activity || options.data || options.extra?.length || options.require?.length || options.label || options.model);
  if (options.launch?.length) {
    if (flags) throw new UserError('use --launch files or the launch flags (--open, --app, --model, --require …), not both');
    return Promise.all(options.launch.map(async file => {
      let json: unknown;
      try { json = JSON.parse(await readFile(file, 'utf8')); } catch (error) { throw new UserError(`${file}: ${(error as Error).message}`); }
      const parsed = launchSchema.safeParse(json);
      if (!parsed.success) throw new UserError(`${file} is not a launch: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      return parsed.data;
    }));
  }
  if (!flags) return undefined;
  return [launchFrom(options, options.label, models)];
}

/** Every --model path the flags name, shared or per option, once each. */
export const modelFiles = (options: LaunchOptions): string[] =>
  [...new Set((options.optionGroups ? [options.optionGroups.shared.model, ...options.optionGroups.options.map(o => o.model)] : [options.model]).filter((f): f is string => Boolean(f)))];

/** A .glb as its launch step: read, checked as the receiver will check it, and named by its sha256. */
export async function modelStep(file: string): Promise<{ step: ModelStep; data: Buffer }> {
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) throw new UserError(`--model ${file}: no such file`);
  if (info.size > MODEL_MAX_BYTES) throw new UserError(`--model ${file}: ${megabytes(info.size)} is over the ${megabytes(MODEL_MAX_BYTES)} a model may be`);
  const name = modelNameSchema.safeParse(basename(file));
  if (!name.success) throw new UserError(`--model ${file}: ${name.error.issues[0].message}`);
  const data = await readFile(file);
  const { problems } = inspectGlb(data, basename(file));
  if (problems.length) throw new UserError(problems.join('\n'));
  return { step: { do: 'model', sha256: createHash('sha256').update(data).digest('hex'), name: name.data, bytes: data.length }, data };
}

/** Pushes each --model to the project's store (a no-op for one already there) before the message names it. */
async function pushModels(cli: Cli, server: Remote, project: string, options: LaunchOptions): Promise<PushedModels> {
  const pushed = new Map<string, ModelStep>();
  for (const file of modelFiles(options)) {
    const { step, data } = await modelStep(file);
    await server.json('PUT', `/v1/projects/${project}/models/${step.sha256}`, z.looseObject({ sha256: z.literal(step.sha256) }), data, 300_000);
    if (!cli.json) cli.print(`${step.name} (${megabytes(step.bytes)}) is on the receiver for ${project}`);
    pushed.set(file, step);
  }
  return pushed;
}

async function textFrom(options: { text?: string; textFile?: string }): Promise<string | undefined> {
  if (options.text && options.textFile) throw new UserError('use --text or --text-file, not both');
  return options.textFile ? (await readFile(options.textFile, 'utf8')).trim() || undefined : options.text?.trim() || undefined;
}

/** `as`: what an agent calls itself, "Opus 5.5", so its messages read "Opus 5.5 on Robin's Mac". `photo`: files to send with it. */
export interface PostOptions extends LaunchOptions { text?: string; textFile?: string; project?: string; cwd?: string; as?: string; photo?: string[] }

function agentName(options: PostOptions): string | undefined {
  const value = options.as ?? process.env.POLYCAP_AS;
  if (value === undefined || value === '') return undefined;
  const parsed = agentNameSchema.safeParse(value);
  if (!parsed.success) throw new UserError(`--as ${value}: ${parsed.error.issues[0].message}`);
  return parsed.data;
}

export async function threadNew(cli: Cli, title: string | undefined, options: PostOptions): Promise<string> {
  if (!title?.trim()) throw new UserError('a thread needs a title: polycap thread new --title "New menu" --text "…"');
  const server = await serverFor(cli, options.cwd);
  const project = await projectFor(server, options.project, options.cwd ?? process.cwd());
  if (!project) throw new UserError('which project? Add --project MUS, or run polycap link MUS in this repository');
  const text = await textFrom(options);
  const launches = await launchesFrom(options, await pushModels(cli, server, project, options));
  if (!text && !launches && !options.photo?.length) throw new UserError('a message needs --text, a --photo or a launch (--open, --app, --model, --require, --launch)');
  const as = agentName(options);
  const photos = await pushPhotos(cli, server, { project }, options.photo ?? []);
  const thread = await server.json('POST', '/v1/threads', threadSchema, { project, title: title.trim(), ...(text ? { text } : {}), ...(launches ? { launches } : {}), ...(photos ? { photos } : {}), ...(as ? { as } : {}) });
  cli.print(cli.json ? JSON.stringify({ key: thread.key, message: thread.messages.at(-1)?.id }) : `${thread.key} opened: ${thread.title}`);
  return thread.key;
}

export async function threadReply(cli: Cli, ref: string, options: PostOptions): Promise<number> {
  const server = await serverFor(cli, options.cwd);
  const key = threadKeyFor(ref, await projectFor(server, options.project, options.cwd ?? process.cwd()));
  const text = await textFrom(options);
  const launches = await launchesFrom(options, await pushModels(cli, server, key.split('-')[0], options));
  if (!text && !launches && !options.photo?.length) throw new UserError('a message needs --text, a --photo or a launch (--open, --app, --model, --require, --launch)');
  const as = agentName(options);
  const photos = await pushPhotos(cli, server, { thread: key }, options.photo ?? []);
  const thread = await server.json('POST', `/v1/threads/${key}/messages`, threadSchema, { ...(text ? { text } : {}), ...(launches ? { launches } : {}), ...(photos ? { photos } : {}), ...(as ? { as } : {}) });
  const id = thread.messages.at(-1)!.id;
  cli.print(cli.json ? JSON.stringify({ key, message: id }) : `${key} #${id} posted`);
  return id;
}

export async function threadReact(cli: Cli, ref: string, message: string, reaction: string, options: { project?: string; cwd?: string } = {}): Promise<void> {
  const name = reactionName(reaction);
  if (!name) throw new UserError(`reactions are ${REACTION_NAMES.map(n => `${n} ${REACTIONS[n]}`).join(', ')}`);
  if (!/^[1-9]\d*$/.test(message)) throw new UserError(`"${message}" is not a message number`);
  const server = await serverFor(cli, options.cwd);
  const key = threadKeyFor(ref, await projectFor(server, options.project, options.cwd ?? process.cwd()));
  const thread = await server.json('POST', `/v1/threads/${key}/reactions`, threadSchema, { message: Number(message), reaction: name });
  const mine = thread.messages.find(m => m.id === Number(message))?.reactions.find(r => r.by.id === thread.me);
  cli.print(cli.json ? JSON.stringify({ key, message: Number(message), reaction: mine?.reaction ?? null }) : mine ? `${key} #${message}: ${REACTIONS[mine.reaction]}` : `${key} #${message}: reaction taken back`);
}

export async function threadUpdate(cli: Cli, ref: string, change: { state?: 'open' | 'closed'; title?: string }, options: { project?: string; cwd?: string } = {}): Promise<void> {
  const server = await serverFor(cli, options.cwd);
  const key = threadKeyFor(ref, await projectFor(server, options.project, options.cwd ?? process.cwd()));
  // Every change goes by POST: the hosted receiver's nginx passes no PATCH (403 for close on 2026-10-15,
  // and for rename on 2026-11-02, when MUS-26 could be closed but not renamed).
  let thread: z.infer<typeof threadSchema> | undefined;
  if (change.title !== undefined) thread = await server.json('POST', `/v1/threads/${key}/title`, threadSchema, { title: change.title });
  if (change.state) thread = await server.json('POST', `/v1/threads/${key}/state`, threadSchema, { state: change.state });
  if (!thread) throw new UserError('say a state or a title');
  cli.print(cli.json ? JSON.stringify({ key, state: thread.state, title: thread.title }) : `${key} · ${thread.title} · ${thread.state}`);
}

const memberNames = (members: { person: string; name: string }[]) => members.map(m => m.name === m.person ? m.person : `${m.name} (${m.person})`).join(', ');

/** The team adds people to a thread, or takes them out, by person id (2026-10-21): what lets someone outside the team see it. */
export async function threadMembers(cli: Cli, ref: string, change: { add?: string[]; remove?: string[]; history?: 'hidden' | 'visible' }, options: { project?: string; cwd?: string } = {}): Promise<void> {
  const server = await serverFor(cli, options.cwd);
  const key = threadKeyFor(ref, await projectFor(server, options.project, options.cwd ?? process.cwd()));
  const thread = await server.json('POST', `/v1/threads/${key}/members`, threadSchema, change);
  const members = thread.members ?? [];
  cli.print(cli.json ? JSON.stringify({ key, members }) : `${key} · ${thread.title} · members: ${members.length ? memberNames(members) : 'none'}`);
}

const welcomedSchema = z.strictObject({ key: z.string(), opened: z.boolean() });

const participantLine = (p: { email: string; emailed?: boolean; emailNote?: string }) => `${p.email}: ${p.emailed ? 'emailed' : `not emailed${p.emailNote ? ` (${p.emailNote})` : ''}`}`;

/**
 * Copies addresses into a thread, takes them out, or (the team) sends a failed invitation again (2026-11-10):
 * the team's additions are each emailed who added them and the thread's title, with how to join. Prints each
 * address with whether it was emailed; one just added is usually still on its way ("sending").
 */
export async function threadInvite(cli: Cli, ref: string, change: { add?: string[]; remove?: string[]; resend?: string[]; history?: 'hidden' | 'visible' }, options: { project?: string; cwd?: string } = {}): Promise<void> {
  const server = await serverFor(cli, options.cwd);
  const key = threadKeyFor(ref, await projectFor(server, options.project, options.cwd ?? process.cwd()));
  const thread = await server.json('POST', `/v1/threads/${key}/participants`, threadSchema, change);
  const participants = thread.participants ?? [];
  if (cli.json) { cli.print(JSON.stringify({ key, participants })); return; }
  cli.print(`${key} · ${thread.title} · ${participants.length ? `${participants.length} invited by email` : 'nobody invited by email'}`);
  for (const p of participants) cli.print(`  ${participantLine(p)}`);
}

const meSchema = z.looseObject({
  me: z.string(), device: z.string().nullable(),
  /** Receivers before 2026-11-12 do not say; null is never. */
  expiresAt: z.string().nullable().optional(),
  person: z.looseObject({ id: z.string(), name: z.string(), email: z.string().optional(), emailVerified: z.boolean() }),
  confirmation: z.looseObject({ status: z.string(), note: z.string().optional() }).optional(),
});

/**
 * This token's person and their own address; with --email, sets it as the headset's account sheet does, and the
 * receiver emails a link to confirm it (2026-11-10). With a test person's token, that is how to try being invited
 * by email without a headset (docs/THREADS.md, Invited by email).
 */
export async function me(cli: Cli, change: { email?: string | null } = {}, options: { cwd?: string } = {}): Promise<void> {
  const server = await serverFor(cli, options.cwd);
  const view = change.email === undefined ? await server.json('GET', '/v1/me', meSchema) : await server.json('POST', '/v1/me', meSchema, { email: change.email });
  if (cli.json) { cli.print(JSON.stringify(view)); return; }
  const { person } = view;
  cli.print(`${person.name} (${person.id})${view.device ? ` · ${view.device}` : ''}`);
  cli.print(person.email ? `Address: ${person.email} · ${person.emailVerified ? 'confirmed' : 'not confirmed yet'}` : 'No address');
  if (view.confirmation) cli.print(view.confirmation.status === 'sending' ? 'A link to confirm it is on its way by email.' : `No confirmation email: ${view.confirmation.note ?? view.confirmation.status}`);
  if (view.expiresAt !== undefined) cli.print(view.expiresAt ? `This token (${view.me}) expires ${view.expiresAt.slice(0, 10)}` : `This token (${view.me}) never expires`);
}

/**
 * The team opens someone's Welcome thread (2026-11-10, server/welcome.ts): for anyone who signed in before the
 * receiver had one, or to try it on your own headset. Signing in opens it by itself; with one already there
 * this says which, unless --again opens another.
 */
export async function threadWelcome(cli: Cli, person: string, options: { again?: boolean; cwd?: string } = {}): Promise<void> {
  const server = await serverFor(cli, options.cwd);
  const welcomed = await server.json('POST', '/v1/welcome', welcomedSchema, { person, ...(options.again ? { again: true } : {}) });
  cli.print(cli.json ? JSON.stringify({ person, ...welcomed }) : `${welcomed.key} · Welcome to Polydance · ${welcomed.opened ? 'opened for' : 'already there for'} ${person}`);
}

function eventLine(event: ThreadEvent): string {
  const d = new Date(event.at);
  const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const detail = event.kind === 'recording.ready' ? `${event.title ? `"${event.title}" ` : ''}→ session ${event.sessionId}`
    : event.kind === 'recording.words' ? `${event.title ? `"${event.title}" ` : ''}→ session ${event.sessionId}, words only: the video is still uploading`
    : event.kind === 'recording.failed' ? event.error ?? ''
      : event.kind === 'reaction' ? `${event.reaction ? REACTIONS[event.reaction as keyof typeof REACTIONS] ?? event.reaction : 'took back a reaction'} on #${event.message}`
        : event.kind === 'pick' ? (typeof event.launch === 'number' ? `★ option ${event.launch + 1} in #${event.message}` : `took back the pick in #${event.message}`)
        : event.kind === 'renamed' ? `"${event.title}"`
          : event.message ? `#${event.message}${event.photos ? ` with ${event.photos === 1 ? 'a photo' : `${event.photos} photos`}: polycap thread show ${event.thread} saves them` : ''}` : '';
  return `${clock} ${event.thread} ${event.kind} ${who(event.by)}${detail ? `: ${detail}` : ''}`;
}

export interface WatchOptions { project?: string; all?: boolean; once?: boolean; after?: string; timeout?: string; kinds?: string[]; cwd?: string; pollSeconds?: number }

/**
 * Prints events by others as they happen, from the receiver's feed. Starts after the latest event unless
 * --after; rides out a receiver that cannot be reached, and stops on a refused token. --kind keeps only
 * those kinds (recording.ready: the tester's reply is built; recording.words: its words are, video to come). With --once it returns the first event;
 * with --timeout it gives up after that long and returns undefined.
 */
export async function threadWatch(cli: Cli, ref: string | undefined, options: WatchOptions = {}): Promise<ThreadEvent | undefined> {
  const server = await serverFor(cli, options.cwd);
  const project = options.all ? undefined : await projectFor(server, options.project, options.cwd ?? process.cwd());
  const thread = ref ? threadKeyFor(ref, project) : undefined;
  let after: number;
  if (options.after !== undefined) {
    if (!/^\d+$/.test(options.after)) throw new UserError(`--after ${options.after} is not an event id`);
    after = Number(options.after);
  } else after = (await server.json('GET', '/v1/events', eventsSchema)).last;
  const deadline = options.timeout ? Date.now() + parseClockOrThrow(options.timeout) : Number.POSITIVE_INFINITY;
  const unknown = (options.kinds ?? []).filter(kind => !EVENT_KINDS.includes(kind as typeof EVENT_KINDS[number]));
  if (unknown.length) throw new UserError(`--kind ${unknown.join(', ')}: events are ${EVENT_KINDS.join(', ')}`);
  const filter = new URLSearchParams(thread ? { thread } : project ? { project } : {});
  if (!cli.json) cli.warn(`watching ${thread ?? project ?? 'every project'} after event ${after}`);
  let backoff = 1000;
  while (Date.now() < deadline) {
    const wait = Math.max(0, Math.min(options.pollSeconds ?? 25, Math.ceil((deadline - Date.now()) / 1000)));
    let page;
    try {
      page = await server.json('GET', `/v1/events?after=${after}&wait=${wait}${filter.size ? `&${filter}` : ''}`, eventsSchema, undefined, (wait + 30) * 1000);
      backoff = 1000;
    } catch (error) {
      if (!(error instanceof RemoteError) || (error.status !== undefined && error.status < 500)) throw error;
      cli.warn(`${error.message}; trying again in ${backoff / 1000}s`);
      await sleep(Math.min(backoff, Math.max(0, deadline - Date.now())));
      backoff = Math.min(backoff * 2, 30_000);
      continue;
    }
    for (const event of page.events) {
      after = event.id;
      if (event.by.id === page.me || (options.kinds?.length && !options.kinds.includes(event.kind))) continue;
      cli.print(cli.json ? JSON.stringify(event) : eventLine(event));
      if (options.once) return event;
    }
    after = Math.max(after, page.last);
  }
  if (!cli.json) cli.warn(`no events by others within ${options.timeout}`);
  return undefined;
}

function parseClockOrThrow(value: string): number {
  try { return parseClock(value); } catch (error) { throw new UserError(`--timeout: ${(error as Error).message}`); }
}
