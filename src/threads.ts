/**
 * Threads, as the receiver and the CLI share them: project and thread keys, the launch format, the six
 * reactions and the host patterns a project allows. The terms are locked in docs/THREADS.md
 * (2026-10-03); the headset app mirrors the launch format in Kotlin. A launch is a remote "open this" on
 * someone's headset, so everything here validates strictly and the receiver checks each step against
 * its project before accepting it.
 */
import { z } from 'zod';
import { MODEL_MAX_BYTES, modelNameSchema, SHA256 } from './glb.js';

export const PROJECT_KEY = /^[A-Z][A-Z0-9]{1,9}$/;
export const THREAD_KEY = /^([A-Z][A-Z0-9]{1,9})-([1-9][0-9]{0,5})$/;
export const projectKeySchema = z.string().regex(PROJECT_KEY, 'a project key is 2 to 10 capital letters or digits, starting with a letter');
export const threadKeySchema = z.string().regex(THREAD_KEY, 'a thread key looks like MUS-12');

/** The fixed set, by name, with the emoji the headset draws; what each one means is up to the team. */
export const REACTIONS = { heart: '❤️', 'thumbs-up': '👍', 'thumbs-down': '👎', haha: '😂', emphasis: '‼️', question: '❓' } as const;
export type Reaction = keyof typeof REACTIONS;
export const REACTION_NAMES = Object.keys(REACTIONS) as [Reaction, ...Reaction[]];

const stripSelector = (s: string) => s.replace(/️/g, '');

/** A reaction's name, given its name or its emoji (with or without the variation selector); undefined for anything else. */
export function reactionName(input: string): Reaction | undefined {
  const value = input.trim();
  if ((REACTION_NAMES as string[]).includes(value)) return value as Reaction;
  return REACTION_NAMES.find(name => stripSelector(REACTIONS[name]) === stripSelector(value));
}

const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
export const packageSchema = z.string().max(200).regex(PACKAGE, 'not an Android package name');

export function isHttpsUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname !== '' && !url.username && !url.password; }
  catch { return false; }
}

/** Schemes a data URI may not use: they reach files, other apps or script rather than the named app's own links. */
const BLOCKED_SCHEMES = new Set(['file', 'content', 'intent', 'javascript', 'data', 'android-app', 'android.resource']);
const dataUri = z.string().max(2000).refine(value => {
  const scheme = value.match(/^([a-z][a-z0-9+.-]*):/i)?.[1].toLowerCase();
  return scheme !== undefined && !BLOCKED_SCHEMES.has(scheme);
}, 'must be a link the app handles itself, not file:, content:, intent: or javascript:');

export const stepSchema = z.discriminatedUnion('do', [
  z.strictObject({
    do: z.literal('require'), package: packageSchema,
    versionName: z.string().min(1).max(80).optional(), versionCode: z.number().int().nonnegative().optional(), minVersionCode: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({ do: z.literal('open'), url: z.string().max(2000).refine(isHttpsUrl, 'must be an https link') }),
  z.strictObject({
    do: z.literal('app'), package: packageSchema,
    activity: z.string().regex(/^[A-Za-z0-9_.$]{1,200}$/, 'not an activity name').optional(),
    data: dataUri.optional(),
    extras: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,63}$/, 'not an extra name'), z.union([z.string().max(500), z.number(), z.boolean()]))
      .refine(extras => Object.keys(extras).length <= 20, 'at most 20 extras').optional(),
  }),
  // A 3D model pushed to the project's store (PUT /v1/projects/:key/models/:sha256), opened in Polydance's own viewer panel (2026-10-19).
  z.strictObject({
    do: z.literal('model'), sha256: z.string().regex(SHA256, 'a model is named by its sha256, 64 lowercase hex digits'),
    name: modelNameSchema, bytes: z.number().int().positive().max(MODEL_MAX_BYTES),
  }),
]);
export type LaunchStep = z.infer<typeof stepSchema>;
export type ModelStep = Extract<LaunchStep, { do: 'model' }>;
export const launchSchema = z.strictObject({ label: z.string().trim().min(1).max(40).optional(), steps: z.array(stepSchema).min(1).max(8) })
  .refine(launch => launch.steps.filter(s => s.do === 'model').length <= 1, 'a launch opens at most one model');
export type Launch = z.infer<typeof launchSchema>;
export const launchesSchema = z.array(launchSchema).min(1).max(6);

/** Which of a message's launches a recording answers. */
export const replyToSchema = z.strictObject({ message: z.number().int().positive(), launch: z.number().int().nonnegative().optional() });

/** What a session records about its thread, so the bundle and its summary know what was asked. */
export const sessionThreadSchema = z.strictObject({
  key: threadKeySchema, project: projectKeySchema, title: z.string(),
  /** This recording opened the thread (recorded with no thread open, or with +). */
  opened: z.boolean(),
  /** The team's message it answers, with the launch the tester started. */
  replyTo: z.strictObject({ message: z.number().int().positive(), text: z.string().optional(), launch: launchSchema.optional() }).optional(),
  /** Sent from the deck's bug key: a bug or feature request about Polydance itself, seen only by the team (2026-10-12). */
  report: z.literal(true).optional(),
});
export type SessionThread = z.infer<typeof sessionThreadSchema>;

/**
 * What the bug key asks, in the words of its pop-up; the summary reads a report against it the way it
 * reads a reply against the team's message.
 */
export const REPORT_ASK = 'Report a bug in Polydance, the headset recorder this was made with, or suggest a feature for it.';

/** A host, with `*` allowed once in the first label: marimba-demo-*-yourteam.vercel.app (hostMatches says what it takes). */
const HOST_PATTERN = /^[a-z0-9-]*\*?[a-z0-9-]*(\.[a-z0-9-]+)+$/;
export const projectSchema = z.strictObject({
  key: projectKeySchema,
  name: z.string().trim().min(1).max(60),
  /** Hosts an `open` step may go to. */
  hosts: z.array(z.string().regex(HOST_PATTERN, 'a host, with * allowed once in the first label')).max(50).default([]),
  /** Packages an `app` step may open. */
  packages: z.array(packageSchema).max(50).default([]),
});
export type Project = z.infer<typeof projectSchema>;

/** A person on the receiver (POLYCAP_USERS): a token names the person it belongs to, so a message says who sent it. */
export const USER_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const userSchema = z.strictObject({
  id: z.string().regex(USER_ID, 'a user id is lowercase letters, digits and dashes'),
  name: z.string().trim().min(1).max(60),
  /** The avatar's colour; without one the headset picks one from the id. */
  colour: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a colour is #rrggbb').optional(),
});
export type User = z.infer<typeof userSchema>;

/** POLYCAP_USERS: none means messages carry only the token's label; a malformed list is an error at start-up. */
export function parseUsers(raw: string | undefined): User[] {
  if (!raw?.trim()) return [];
  let json: unknown;
  try { json = JSON.parse(raw); } catch { throw new Error('POLYCAP_USERS is not JSON'); }
  const parsed = z.array(userSchema).safeParse(json);
  if (!parsed.success) throw new Error(`POLYCAP_USERS: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  if (new Set(parsed.data.map(u => u.id)).size !== parsed.data.length) throw new Error('POLYCAP_USERS has duplicate ids');
  return parsed.data;
}

/** What an agent calls itself in a message, "Opus 5.5": letters, digits, spaces and a little punctuation. */
export const agentNameSchema = z.string().trim().min(1).max(40).regex(/^[\p{L}\p{N} .,'()+-]+$/u, 'an agent name is letters, digits, spaces and . , \' ( ) + -');

/**
 * How a message's sender reads (2026-10-04, Robin): an agent as "Opus 5.5 on Robin's Mac", a person's
 * device as "Robin · Quest 3", and a token with no person as its label. An agent that is its own token,
 * as the receiver's Welcome is (2026-11-10), reads as its name alone: "Polydance", not "Polydance on Polydance".
 */
export function displayName(label: string, user?: { name: string }, agent?: string): string {
  if (agent && !user && agent === label) return agent;
  if (agent) return `${agent} on ${user ? `${user.name}'s ` : ''}${label}`;
  return user ? `${user.name} · ${label}` : label;
}

/** POLYCAP_PROJECTS: none means threads are off; a malformed list is an error at start-up, never ignored. */
export function parseProjects(raw: string | undefined): Project[] {
  if (!raw?.trim()) return [];
  let json: unknown;
  try { json = JSON.parse(raw); } catch { throw new Error('POLYCAP_PROJECTS is not JSON'); }
  const parsed = z.array(projectSchema).safeParse(json);
  if (!parsed.success) throw new Error(`POLYCAP_PROJECTS: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const keys = new Set(parsed.data.map(p => p.key));
  if (keys.size !== parsed.data.length) throw new Error('POLYCAP_PROJECTS has duplicate keys');
  return parsed.data;
}

/**
 * A person's own project (2026-11-13, docs/THREADS.md "Projects of your own"): its owner is a person id
 * (people.ts personId), and it lives in the receiver's projects.json, never POLYCAP_PROJECTS.
 */
export const ownProjectSchema = projectSchema.extend({
  owner: z.string().regex(/^[a-z0-9][a-z0-9-]{0,80}$/, 'an owner is a person id'),
  createdAt: z.iso.datetime({ offset: true }),
});
export type OwnProject = z.infer<typeof ownProjectSchema>;

/** How many projects one person may make: enough for anyone's work, few enough that nobody fills the key space. */
export const MAX_OWN_PROJECTS = 20;

/**
 * Hosting where anyone names their own hosts: a whole `*` label in front of one of these would let a person's
 * launches open anyone's site there, so a person's own project may not have one. The team's projects are the
 * team's to judge (docs/THREADS.md, Safety).
 */
export const SHARED_HOST_SUFFIXES = ['vercel.app', 'netlify.app', 'github.io', 'pages.dev', 'web.app', 'firebaseapp.com'] as const;

/** Why a host pattern is too wide for a person's own project, or undefined when it may have it. */
export function ownHostProblem(pattern: string): string | undefined {
  const [first, ...rest] = pattern.split('.');
  if (!first.includes('*')) return undefined;
  if (rest.length < 2) return `${pattern}: a * needs a domain of at least two labels after it`;
  const shared = (SHARED_HOST_SUFFIXES as readonly string[]).includes(rest.join('.'));
  if (shared && (first.startsWith('*') || first.endsWith('*'))) return `${pattern}: on ${rest.join('.')} anyone names their own hosts, so a * there must sit between a prefix and a suffix (a deployment hash), or list the exact host`;
  return undefined;
}

/** What `POST /v1/projects` takes: a name, and optionally the key, hosts and packages. */
export const newProjectSchema = z.strictObject({
  name: z.string().trim().min(1, 'a project needs a name').max(60, 'a project name is at most 60 characters').regex(/^[^\p{Cc}]+$/u, 'a project name has no control characters'),
  key: z.string().trim().toUpperCase().pipe(projectKeySchema).optional(),
  hosts: projectSchema.shape.hosts.unwrap().optional(),
  packages: projectSchema.shape.packages.unwrap().optional(),
}).superRefine((input, ctx) => {
  for (const [i, host] of (input.hosts ?? []).entries()) {
    const problem = ownHostProblem(host);
    if (problem) ctx.addIssue({ code: 'custom', path: ['hosts', i], message: problem });
  }
});
export type NewProject = z.infer<typeof newProjectSchema>;

/**
 * What `POST /v1/projects/:key` takes (2026-11-20): the whole new list of hosts, of packages, or both, under the
 * rules a new project's are. A project is often made in the headset by name alone, before its owner knows where
 * their previews live.
 */
export const editProjectSchema = z.strictObject({
  hosts: projectSchema.shape.hosts.unwrap().optional(),
  packages: projectSchema.shape.packages.unwrap().optional(),
}).superRefine((input, ctx) => {
  if (input.hosts === undefined && input.packages === undefined) ctx.addIssue({ code: 'custom', path: [], message: 'say the new hosts, the new packages, or both' });
  for (const [i, host] of (input.hosts ?? []).entries()) {
    const problem = ownHostProblem(host);
    if (problem) ctx.addIssue({ code: 'custom', path: ['hosts', i], message: problem });
  }
  for (const list of ['hosts', 'packages'] as const) {
    if (new Set(input[list] ?? []).size !== (input[list] ?? []).length) ctx.addIssue({ code: 'custom', path: [list], message: 'each one once' });
  }
});
export type EditProject = z.infer<typeof editProjectSchema>;

/**
 * The key a name makes: its first letters and digits, four at most and starting with a letter, then a number
 * from 2 when that is taken (Spottisphone → SPOT, SPOT2). A name with fewer than two makes PROJ.
 */
export function projectKeyFrom(name: string, taken: (key: string) => boolean): string {
  const letters = name.normalize('NFKD').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^[0-9]+/, '');
  const base = letters.length >= 2 ? letters.slice(0, 4) : 'PROJ';
  if (!taken(base)) return base;
  for (let n = 2; n < 1000; n += 1) if (!taken(`${base}${n}`)) return `${base}${n}`;
  throw new Error(`every key from ${base} is taken; ask for one with key`);
}

/**
 * `*` alone is one whole label (`*.marimba.example`), and at either end of a label it takes letters, digits
 * and hyphens. Between a prefix and a suffix (`marimba-demo-*-yourteam.vercel.app`) it is a Vercel
 * deployment hash, nine letters or digits, and nothing else: Vercel joins project, hash and team with
 * hyphens and team slugs may have them, so a star that took hyphens would let in another team's
 * `…-abc123xyz-evil-yourteam`, and a branch link (`-git-<branch>-`) is a name another team can make.
 * What a pattern still cannot rule out is in docs/THREADS.md (Safety).
 */
export function hostMatches(pattern: string, host: string): boolean {
  const want = pattern.split('.'), have = host.toLowerCase().split('.');
  if (want.length !== have.length || want.slice(1).join('.') !== have.slice(1).join('.')) return false;
  const [first] = want;
  if (!first.includes('*')) return first === have[0];
  const [before, after] = first.split('*');
  const middle = first === '*' ? '[a-z0-9-]+' : before && after ? '[a-z0-9]{9}' : '[a-z0-9-]*';
  return new RegExp(`^${before}${middle}${after}$`).test(have[0]);
}

/** Every step a project does not allow, in words; empty when the launches may be sent. */
export function launchProblems(launches: readonly Launch[], project: Project): string[] {
  const problems: string[] = [];
  launches.forEach((launch, i) => launch.steps.forEach((step, j) => {
    const where = `launch ${i + 1} step ${j + 1}`;
    if (step.do === 'open') {
      const host = new URL(step.url).hostname;
      if (!project.hosts.some(pattern => hostMatches(pattern, host))) problems.push(`${where}: ${host} is not one of ${project.key}'s hosts (${project.hosts.join(', ') || 'none'})`);
    }
    if (step.do === 'app' && !project.packages.includes(step.package)) problems.push(`${where}: ${step.package} is not one of ${project.key}'s packages (${project.packages.join(', ') || 'none'})`);
  }));
  return problems;
}

const versionWords = (step: Extract<LaunchStep, { do: 'require' }>) =>
  [step.versionName, step.versionCode !== undefined ? `(${step.versionCode})` : '', step.minVersionCode !== undefined ? `at least (${step.minVersionCode})` : ''].filter(Boolean).join(' ');

/** 4.2 MB or 640 kB, as a person reads a file's size. */
export const megabytes = (bytes: number) => bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} kB` : `${(bytes / 1e6).toFixed(1)} MB`;

/** Every model the launches open, once each. */
export const modelSteps = (launches: readonly Launch[]): ModelStep[] =>
  [...new Map(launches.flatMap(l => l.steps).filter((s): s is ModelStep => s.do === 'model').map(s => [s.sha256, s])).values()];

/** "require com.x 2.3.1 (231); open https://…" for the CLI and the storyboard. */
export function describeLaunch(launch: Launch): string {
  const steps = launch.steps.map(step => {
    switch (step.do) {
      case 'require': return `require ${step.package}${versionWords(step) ? ` ${versionWords(step)}` : ''}`;
      case 'open': return `open ${step.url}`;
      case 'model': return `open model ${step.name} (${megabytes(step.bytes)})`;
      case 'app': {
        const extras = Object.entries(step.extras ?? {}).map(([k, v]) => `${k}=${v}`);
        return `open app ${step.package}${step.activity ? `/${step.activity}` : ''}${step.data ? ` with ${step.data}` : ''}${extras.length ? ` (${extras.join(', ')})` : ''}`;
      }
    }
  });
  return `${launch.label ? `${launch.label}: ` : ''}${steps.join('; ')}`;
}

/** "MUS-12" as given, or a bare number in the default project. */
export function threadKey(ref: string, project: string | undefined): string {
  const value = ref.trim().toUpperCase();
  if (THREAD_KEY.test(value)) return value;
  if (/^[1-9][0-9]{0,5}$/.test(value)) {
    if (!project) throw new Error(`"${ref}" needs a project: say MUS-${value}, or run polycap link <PROJECT> in this repository`);
    return `${project}-${value}`;
  }
  throw new Error(`"${ref}" is not a thread: use a key such as MUS-12, or a number in this repository's project`);
}
