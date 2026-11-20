/**
 * Threads on the hosted receiver: <root>/threads/<KEY>.json, one file per thread, and events.jsonl, the
 * append-only feed `polycap thread watch` waits on. One process writes, so a promise chain is the lock:
 * every change reads a thread, edits it and writes it back atomically, then appends its events. A
 * recording is a message that points at an upload; the HTTP layer reads its status, session and summary
 * live from the upload store, so a thread and its uploads never disagree. A report from the deck's bug
 * key opens a thread of its own in the reports project, marked `report`, which only the team's tokens
 * see. A thread can also name people by email address (participants), whom nobody emails yet, and a
 * token can hide one from its inbox until someone else adds to it. The team adds people by person id
 * (members, 2026-10-21): a thread-scoped grant (tokens.ts) sees only the threads it is a member of, and
 * every other one is a 404 that does not say whether it exists. Someone added later sees the thread from the
 * change that added them, as in a messaging app (2026-11-12): `viewer` trims what they read, and every route reads
 * through it. Whether they see what came before is chosen when they are added and kept with them (`history`), so
 * changing POLYCAP_NEW_MEMBER_HISTORY, the default for new adds, never reveals anything to people already in. A message
 * can hold photos (2026-11-07), sent to the photo store first and named here by id; an upload token, which
 * posts nothing else, may post them. Terms: docs/THREADS.md.
 */
import { EventEmitter } from 'node:events';
import { appendFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { exists, privateDir, readJson, writeJsonAtomic } from '../fsx.js';
import type { ModelStore } from './models.js';
import type { PhotoStore } from './photos.js';
import { MAX_PHOTOS, photoSchema, type Photo } from '../photo.js';
import {
  displayName, launchesSchema, launchProblems, modelSteps, projectKeySchema, REACTION_NAMES, replyToSchema, THREAD_KEY, threadKeySchema,
  type EditProject, type Launch, type NewProject, type OwnProject, type Project, type Reaction, type SessionThread, type User,
} from '../threads.js';
import { emailSchema, PERSON_ID, personId, verifiedEmail, type People } from './people.js';
import { isTeam, memberScoped, ownsUpload, type Grant } from './tokens.js';
import type { OwnProjects } from './projects.js';

export { isTeam };

export const EVENT_KINDS = ['thread.new', 'message', 'recording', 'recording.words', 'recording.ready', 'recording.failed', 'reaction', 'pick', 'closed', 'reopened', 'renamed', 'people'] as const;
export type EventKind = typeof EVENT_KINDS[number];

const authorSchema = z.strictObject({
  /** The token, and its label (the device, or the machine an agent runs on). */
  id: z.string(), name: z.string(),
  /** The person the token belongs to, as named when this was written. */
  user: z.strictObject({ id: z.string(), name: z.string(), colour: z.string().optional() }).optional(),
  /** What an agent called itself, "Opus 5.5". */
  as: z.string().optional(),
  /** How it reads: "Opus 5.5 on Robin's Mac", "Robin · Quest 3". Older messages have only the label. */
  display: z.string().optional(),
});
export type Author = z.infer<typeof authorSchema>;

/** Who a change is by: the token, its person if it names one, and an agent's own name. */
export function author(grant: Grant, users: readonly User[] = [], as?: string): Author {
  const user = grant.user ? users.find(u => u.id === grant.user) : undefined;
  const name = grant.label ?? grant.id;
  return {
    id: grant.id, name,
    ...(user ? { user: { id: user.id, name: user.name, ...(user.colour ? { colour: user.colour } : {}) } } : {}),
    ...(as ? { as } : {}),
    display: displayName(name, user, as),
  };
}

/**
 * How an upload names its thread: a reply in one, a new thread in a project, or a report from the bug key,
 * which opens a thread of its own in the receiver's reports project. Without it, a new thread in the
 * token's first project.
 */
export const uploadThreadSchema = z.union([
  z.strictObject({ key: threadKeySchema, replyTo: replyToSchema.optional() }),
  z.strictObject({ project: projectKeySchema }),
  z.strictObject({ report: z.literal(true) }),
]);
export type UploadThreadRef = z.infer<typeof uploadThreadSchema>;
export const isReportRef = (ref: UploadThreadRef | undefined): ref is { report: true } => Boolean(ref && 'report' in ref);

/** An opaque reply key, scoped to a thread and the posting token's id; UUIDs fit this format. */
export const deliveryIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, 'deliveryId must contain only letters, digits, underscores or hyphens');

const messageSchema = z.strictObject({
  id: z.number().int().positive(),
  /** The thread's seq when it was posted. */
  seq: z.number().int().positive(),
  at: z.string(),
  by: authorSchema,
  /** Kept with the message, not the event feed, so retries also survive a partial commit. */
  deliveryId: deliveryIdSchema.optional(),
  text: z.string().min(1).max(4000).optional(),
  launches: launchesSchema.optional(),
  /** The tester's reply: an upload, which the receiver turns into a session. */
  recording: z.strictObject({ uploadId: z.string(), clientId: z.string(), replyTo: replyToSchema.optional() }).optional(),
  /** Photos, as the photo store kept them (2026-11-07); messages before then have none. */
  photos: z.array(photoSchema).min(1).max(MAX_PHOTOS).optional(),
  reactions: z.array(z.strictObject({ reaction: z.enum(REACTION_NAMES), by: authorSchema, at: z.string() })),
  /** Which of the message's options each person prefers, at most one each (2026-10-06); threads before then have none. */
  picks: z.array(z.strictObject({ launch: z.number().int().nonnegative(), by: authorSchema, at: z.string() })).default([]),
});
export type ThreadMessage = z.infer<typeof messageSchema>;

/** How many participants a `people` change added and removed: counts only, never the addresses. */
const peopleCounts = { added: z.number().int().positive().optional(), removed: z.number().int().positive().optional() };

const activitySchema = z.strictObject({
  seq: z.number().int().positive(), at: z.string(), kind: z.enum(EVENT_KINDS), by: authorSchema, message: z.number().int().positive().optional(),
  /** A recording's title once its words or bundle are ready, or a thread's new name, for the inbox's latest line. */
  title: z.string().optional(),
  ...peopleCounts,
});

export const MAX_PARTICIPANTS = 50;
/**
 * Chosen when someone is added (2026-11-12): `visible` lets them see what came before. Written only then, so a
 * thread where nobody chose it reads as before; without it, they see what came after they were added.
 */
const historySchema = z.literal('visible').optional();
/** Someone named by email address (2026-10-12): unverified, and not emailed yet. */
const participantSchema = z.strictObject({ email: emailSchema, addedBy: authorSchema, addedAt: z.string(), history: historySchema });
export const MAX_MEMBERS = 50;
/** Someone the team added by person id (2026-10-21): a user id, or a signed-in tester's own person. */
const memberSchema = z.strictObject({ person: z.string().regex(PERSON_ID), addedBy: authorSchema, addedAt: z.string(), history: historySchema });

export const threadSchema = z.strictObject({
  version: z.literal(1),
  key: threadKeySchema, project: projectKeySchema, number: z.number().int().positive(),
  title: z.string().min(1).max(120),
  /** Opened by recording: renamed from that recording's summary once it has one. */
  titleFromRecording: z.boolean(),
  /** Opened by a report from the bug key: only the team sees it (isTeam). */
  report: z.literal(true).optional(),
  state: z.enum(['open', 'closed']),
  createdAt: z.string(), updatedAt: z.string(),
  by: authorSchema,
  /** Counts every change, so what a token has seen is one number. */
  seq: z.number().int().nonnegative(),
  messages: z.array(messageSchema),
  activity: z.array(activitySchema),
  /** Per token id: the seq it has seen up to. */
  reads: z.record(z.string(), z.number().int().nonnegative()),
  /** People named by email address; written only when there are some, so older files read as before. */
  participants: z.array(participantSchema).max(MAX_PARTICIPANTS).optional(),
  /** People the team added, and a thread-scoped grant that opened it; written only when there are some. */
  members: z.array(memberSchema).max(MAX_MEMBERS).optional(),
  /** Per token id: the seq at which it took the thread off its inbox; written only when some token has. */
  hiddenFor: z.record(z.string(), z.number().int().nonnegative()).optional(),
});
export type Thread = z.infer<typeof threadSchema>;

export const eventSchema = z.strictObject({
  id: z.number().int().positive(), at: z.string(), kind: z.enum(EVENT_KINDS),
  thread: threadKeySchema, project: projectKeySchema, by: authorSchema,
  /** In a report's thread, so the feed hides it from a headset's token as the thread is hidden. */
  report: z.literal(true).optional(),
  message: z.number().int().positive().optional(),
  /** For a reaction: the one chosen, or null when it was taken back. */
  reaction: z.enum(REACTION_NAMES).nullable().optional(),
  /** For a pick: the option chosen (0-based), or null when it was taken back. */
  launch: z.number().int().nonnegative().nullable().optional(),
  sessionId: z.string().optional(), title: z.string().optional(), summary: z.string().optional(), error: z.string().optional(),
  /** For `people`: how many participants were added and removed. The feed is kept for ever, so never who. */
  ...peopleCounts,
  /** For a message: how many photos it holds (2026-11-07). */
  photos: z.number().int().positive().max(MAX_PHOTOS).optional(),
});
export type ThreadEvent = z.infer<typeof eventSchema>;
type Change = Omit<ThreadEvent, 'id' | 'thread' | 'project'>;

/** What a built recording tells its thread: its session, and Claude's title and sentence when there are some. */
interface Built { sessionId: string; title?: string; summary?: string }

export class ThreadError extends Error { constructor(readonly status: 400 | 403 | 404 | 409, message: string, readonly extra: object = {}) { super(message); } }

/** Something by someone else that this token has not seen. */
export const unread = (thread: Thread, grantId: string) => thread.activity.some(a => a.seq > (thread.reads[grantId] ?? 0) && a.by.id !== grantId);

const photosIn = (thread: Thread, id: number | undefined) => Boolean(thread.messages.find(m => m.id === id)?.photos?.length);

/** Recordings by others whose words or bundles are ready, picks and photo messages, that this token has not seen: work for an agent. */
export const fresh = (thread: Thread, grantId: string) => new Set(thread.activity
  .filter(a => (a.kind === 'recording.words' || a.kind === 'recording.ready' || a.kind === 'pick' || ((a.kind === 'message' || a.kind === 'thread.new') && photosIn(thread, a.message)))
    && a.seq > (thread.reads[grantId] ?? 0) && a.by.id !== grantId)
  .map(a => a.message)).size;

/** A launch from someone else that this token has not recorded against since. */
export function waiting(thread: Thread, grantId: string): boolean {
  const lastLaunch = thread.messages.findLastIndex(m => Boolean(m.launches?.length) && m.by.id !== grantId);
  return lastLaunch >= 0 && lastLaunch > thread.messages.findLastIndex(m => Boolean(m.recording) && m.by.id === grantId);
}

/**
 * A member of a thread (2026-10-12) sees the addresses in it and plays its recordings: the team, a person
 * the team added (members, 2026-10-21), a participant whose own address is verified, and for a grant that
 * is not thread-scoped, anyone who has posted or recorded in it as that token or its person. A thread-scoped
 * grant's own posts do not count, so taking its person out of members takes it out. Seeing a thread
 * through a project is not enough.
 */
/** Named in the thread itself, by person or by a verified address: what lets anyone into a thread outside the projects they see. */
export const named = (grant: Grant, thread: Pick<Thread, 'participants' | 'members'>, verifiedEmail?: string): boolean =>
  (thread.members ?? []).some(m => m.person === personId(grant))
  || (verifiedEmail !== undefined && (thread.participants ?? []).some(p => p.email === verifiedEmail));

export function isMember(grant: Grant, thread: Pick<Thread, 'messages' | 'participants' | 'members'>, verifiedEmail?: string): boolean {
  return isTeam(grant)
    || (thread.members ?? []).some(m => m.person === personId(grant))
    || (verifiedEmail !== undefined && (thread.participants ?? []).some(p => p.email === verifiedEmail))
    || (!memberScoped(grant) && thread.messages.some(m => m.by.id === grant.id || (grant.user !== undefined && m.by.user?.id === grant.user)));
}

/** A recording plays for a member of its thread, and for whoever owns its upload. */
export const canPlay = (grant: Grant, thread: Pick<Thread, 'messages' | 'participants' | 'members'>, ownerId: string | undefined, verifiedEmail?: string) =>
  isMember(grant, thread, verifiedEmail) || (ownerId !== undefined && ownsUpload(grant, ownerId));

/** A message's photos are seen by the thread's members and by the token that posted them, as recordings are played. */
export const canView = (grant: Grant, thread: Pick<Thread, 'messages' | 'participants' | 'members'>, message: Pick<ThreadMessage, 'by'>, verifiedEmail?: string) =>
  message.by.id === grant.id || isMember(grant, thread, verifiedEmail);

/** "sent a photo", "sent 3 photos". */
export const photoWords = (count: number) => count === 1 ? 'sent a photo' : `sent ${count} photos`;

/** Off this token's inbox (2026-10-12): hidden until someone else does something in it after it was hidden. */
export function hidden(thread: Pick<Thread, 'hiddenFor' | 'activity'>, grantId: string): boolean {
  const at = thread.hiddenFor?.[grantId];
  return at !== undefined && !thread.activity.some(a => a.seq > at && a.by.id !== grantId);
}

const WORDS: Record<EventKind, string> = {
  'thread.new': 'opened the thread', message: 'posted', recording: 'sent a recording', 'recording.words': 'words ready', 'recording.ready': 'recording ready',
  'recording.failed': 'recording failed', reaction: 'reacted', pick: 'picked', closed: 'closed the thread', reopened: 'reopened the thread', renamed: 'renamed the thread',
  people: 'changed who is in the thread',
};

const headcount = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;

/** The latest change as the inbox's line under a thread: who, when, and words a person would use (2026-10-04: it read "recording.ready"). */
export function lastActivity(thread: Thread): { kind: EventKind; by: Author; at: string; text: string } {
  const last = thread.activity.at(-1);
  // Only a trimmed view (viewer) can have none: say nothing rather than something from before.
  if (!last) return { kind: 'people', by: thread.by, at: thread.createdAt, text: '' };
  const message = last.message ? thread.messages.find(m => m.id === last.message) : undefined;
  let text = WORDS[last.kind];
  if (last.kind === 'message' || last.kind === 'thread.new') {
    if (message?.text) text = message.text.replace(/\s+/g, ' ').slice(0, 140);
    else if (message?.photos) text = photoWords(message.photos.length);
    else if (message?.launches) text = `something to try${message.launches.some(l => l.label) ? `: ${message.launches.map(l => l.label).filter(Boolean).join(', ')}` : ''}`;
    else if (message?.recording) text = WORDS.recording;
  }
  if ((last.kind === 'recording.ready' || last.kind === 'recording.words') && last.title) text = `${WORDS[last.kind]}: ${last.title}`;
  if (last.kind === 'renamed' && last.title) text = `renamed it ${last.title}`;
  if (last.kind === 'reaction') text = `reacted to #${last.message}`;
  if (last.kind === 'pick') {
    const pick = message?.picks.find(p => p.by.id === last.by.id);
    const label = pick ? message?.launches?.[pick.launch]?.label : undefined;
    text = pick ? `picked option ${pick.launch + 1}${label ? `: ${label}` : ''} in #${last.message}` : `took back a pick in #${last.message}`;
  }
  if (last.kind === 'people' && (last.added || last.removed)) {
    text = [last.added ? `added ${headcount(last.added)}` : '', last.removed ? `removed ${headcount(last.removed)}` : ''].filter(Boolean).join(' and ');
  }
  return { kind: last.kind, by: last.by, at: last.at, text };
}

/** Whether people added to a thread see what came before: chosen per add, defaulting to POLYCAP_NEW_MEMBER_HISTORY, hidden unless set. */
export const NEW_MEMBER_HISTORY = ['hidden', 'visible'] as const;
export type NewMemberHistory = typeof NEW_MEMBER_HISTORY[number];

/** Unset is hidden, as in most messaging apps; anything else but the two words is refused at start-up. */
export function parseNewMemberHistory(raw: string | undefined): NewMemberHistory {
  const value = raw?.trim() || 'hidden';
  if (!(NEW_MEMBER_HISTORY as readonly string[]).includes(value)) throw new Error(`POLYCAP_NEW_MEMBER_HISTORY is hidden or visible, not ${value}`);
  return value as NewMemberHistory;
}

/** Where a view of a thread begins: after change `since` (its seq), and at time `at`. */
export interface HistoryWindow { since: number; at: string }

/**
 * Where someone's view begins for one way they are in a thread (a member or an invited address): just before
 * the `people` change that added them. Someone in it from its first write (they opened it, or the team opened
 * it with them, as the Welcome) sees all of it. Read from the thread's own activity, so entries written before
 * this rule existed get it too, and the thread file is unchanged.
 */
export function joinedWindow(thread: Pick<Thread, 'activity' | 'createdAt'>, entry: { addedAt: string; addedBy: Pick<Author, 'id'>; history?: 'visible' }): HistoryWindow {
  // Added with what came before: all of it, as if in it from the start.
  if (entry.history === 'visible') return { since: 0, at: thread.createdAt };
  const added = thread.activity.find(a => a.kind === 'people' && a.at === entry.addedAt && a.by.id === entry.addedBy.id);
  if (added) return { since: added.seq - 1, at: added.at };
  const before = thread.activity.filter(a => a.at < entry.addedAt).at(-1);
  return { since: before?.seq ?? 0, at: entry.addedAt };
}

/** The thread as someone sees it from `since`: later messages, and later activity not about an earlier message. */
export function fromWindow(thread: Thread, window: HistoryWindow | undefined): Thread {
  if (!window || window.since <= 0) return thread;
  const messages = thread.messages.filter(m => m.seq > window.since);
  const shown = new Set(messages.map(m => m.id));
  const activity = thread.activity.filter(a => a.seq > window.since && (a.message === undefined || shown.has(a.message)));
  return { ...thread, messages, activity };
}

/** "Recording 3 Oct 14:20" (or "Report …") from the headset's own clock, until the summary names the thread. */
function provisionalTitle(recordedAt: string | undefined, what = 'Recording'): string {
  const match = recordedAt?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return `New ${what.toLowerCase()}`;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(match[2]) - 1];
  return `${what} ${Number(match[3])} ${month} ${match[4]}:${match[5]}`;
}

const FILE = /^([A-Z][A-Z0-9]{1,9})-([1-9][0-9]{0,5})\.json$/;

export interface UploadLink { key: string; message: number }

export class ThreadStore {
  private chain: Promise<unknown> = Promise.resolve();
  private loaded?: Promise<ThreadEvent[]>;
  private readonly emitter = new EventEmitter().setMaxListeners(0);

  /**
   * `reports` is the project reports from the bug key open their threads in (POLYCAP_REPORTS); without it they
   * are refused. `models` holds the 3D models launches may open; without it a launch with a model is refused.
   * `people` gives verified addresses, which make a thread-scoped grant a participant; without it none is.
   * `photos` holds the photos messages may carry; without it a message with photos is refused.
   * `history` is whether people added from now on see what came before, unless whoever adds them chooses (viewer).
   * `projects` are the team's (POLYCAP_PROJECTS); `own` holds people's own projects (projects.ts, 2026-11-13), which
   * only their owner sees whole; without it nobody can make one.
   */
  constructor(
    readonly dir: string, readonly projects: readonly Project[], readonly users: readonly User[] = [], readonly reports?: string, readonly models?: ModelStore,
    private readonly people?: Pick<People, 'emails'>, readonly photos?: PhotoStore, readonly history: NewMemberHistory = 'hidden', readonly own?: OwnProjects,
  ) {
    if (reports && !projects.some(p => p.key === reports)) throw new Error(`the reports project ${reports} is not one of the projects`);
    const clash = own?.list().find(p => projects.some(t => t.key === p.key));
    if (clash) throw new Error(`${clash.key} is a team project and also ${clash.owner}'s own project (projects.json); give the team's another key`);
  }

  private who(grant: Grant, as?: string): Author { return author(grant, this.users, as); }

  /** Off when no projects are configured: uploads then make sessions as before. */
  get enabled(): boolean { return this.projects.length > 0; }
  /** Whether this receiver takes reports from the bug key. */
  get reportsOn(): boolean { return this.enabled && this.reports !== undefined; }
  /** A team project, or anyone's own. */
  project(key: string): Project | undefined { return this.projects.find(p => p.key === key) ?? this.own?.get(key); }
  /** The team's projects this token sees (its `projects`, or all of them), then its person's own. */
  projectsFor(grant: Grant): Project[] {
    return [...this.projects.filter(p => !grant.projects || grant.projects.includes(p.key)), ...this.own?.ownedBy(personId(grant)) ?? []];
  }
  private canSee(grant: Grant, project: string): boolean { return this.projectsFor(grant).some(p => p.key === project); }
  /** Whether this project is the grant's person's own. */
  ownedBy(grant: Pick<Grant, 'id' | 'user'>, project: string): boolean { return this.own?.get(project)?.owner === personId(grant); }
  /** Whether anyone's own project is someone else's than this grant's person: only then can it be in a thread it does not see whole. */
  private othersOwn(grant: Grant): boolean { return this.own?.list().some(p => p.owner !== personId(grant)) ?? false; }

  /**
   * Who changes the people in a thread of this project: in someone's own project, its owner (Robin, 2026-11-13),
   * as the team does in the team's projects.
   */
  managesProject(grant: Grant, project: string): boolean { return this.own?.get(project) ? this.ownedBy(grant, project) : isTeam(grant); }
  manages(grant: Grant, thread: Pick<Thread, 'project'>): boolean { return this.managesProject(grant, thread.project); }

  /**
   * Makes a project of the grant's person's own (POST /v1/projects). Its key may not be a team project's, nor
   * one with threads on disk already (a project taken out of POLYCAP_PROJECTS keeps its threads' keys).
   */
  async createProject(grant: Grant, input: NewProject): Promise<OwnProject> {
    if (!this.enabled) throw new ThreadError(409, 'threads are off on this receiver: POLYCAP_PROJECTS is not set', { reason: 'threads_off' });
    if (!this.own) throw new ThreadError(409, 'this receiver does not make projects', { reason: 'projects_off' });
    const used = new Set((await exists(this.dir) ? await readdir(this.dir) : []).flatMap(name => name.match(FILE)?.[1] ?? []));
    return this.own.create(personId(grant), input, key => used.has(key) || this.projects.some(p => p.key === key));
  }

  /**
   * A project's hosts and packages, for whoever may change them or, in a team project, whoever sends its launches:
   * its owner, or the team for a team project it sees. Anyone else gets the 404 of a key nobody has used.
   */
  describeProject(grant: Grant, key: string): Project {
    const own = this.own?.get(key);
    const project = own ? (own.owner === personId(grant) ? own : undefined) : isTeam(grant) && this.canSee(grant, key) ? this.project(key) : undefined;
    if (!project) throw new ThreadError(404, `no project ${key} for this token`);
    return project;
  }

  /** Changes the hosts and packages of the grant's person's own project (POST /v1/projects/:key, 2026-11-20). */
  async editProject(grant: Grant, key: string, change: EditProject): Promise<OwnProject> {
    const project = await this.own?.edit(personId(grant), key, change);
    if (!project) throw new ThreadError(404, `no project ${key} for this token`);
    return project;
  }

  /**
   * Which threads a grant reads: those in its projects, and a report only for the team. A thread-scoped grant
   * (2026-10-21) reads only threads it is a member of, never a report, whatever its projects: the team added
   * its person by name, so membership is the whole rule.
   */
  private async reader(grant: Grant): Promise<(thread: Thread) => boolean> {
    const scoped = memberScoped(grant);
    if (!scoped && !this.othersOwn(grant)) return thread => this.canSee(grant, thread.project) && (!thread.report || isTeam(grant));
    const mine = this.people ? verifiedEmail(await this.people.emails(), grant) : undefined;
    // Someone else's own project (2026-11-13): the team's tokens too see a thread there only when it names them.
    if (!scoped) return thread => (this.canSee(grant, thread.project) && (!thread.report || isTeam(grant))) || (!thread.report && named(grant, thread, mine));
    return thread => !thread.report && (isMember(grant, thread, mine) || this.ownedBy(grant, thread.project));
  }

  /**
   * Where a grant's view of each thread begins (2026-11-12): for a thread-scoped grant, just before it was added,
   * or the start for a way in added with what came before, by the earliest of the ways its person is in the
   * thread; undefined, all of it, for the team and for headsets that see their projects. Read from what each way
   * in recorded, never the receiver's setting now. In it no way at all (which reader never lets through) is from now.
   */
  async windows(grant: Grant): Promise<(thread: Thread) => HistoryWindow | undefined> {
    const scoped = memberScoped(grant);
    if (!scoped && !this.othersOwn(grant)) return () => undefined;
    const mine = this.people ? verifiedEmail(await this.people.emails(), grant) : undefined;
    const person = personId(grant);
    return thread => {
      // A project's owner sees its threads whole; so does the team in the projects it sees.
      if (this.ownedBy(grant, thread.project) || (!scoped && this.canSee(grant, thread.project))) return undefined;
      const entries = [...(thread.members ?? []).filter(m => m.person === person), ...(mine ? (thread.participants ?? []).filter(p => p.email === mine) : [])];
      const windows = entries.map(entry => joinedWindow(thread, entry)).sort((a, b) => a.since - b.since);
      return windows[0] ?? { since: thread.seq, at: thread.updatedAt };
    };
  }

  /** What a grant reads of each thread it may see: every route shows, plays, syncs and announces through this. */
  async viewer(grant: Grant): Promise<(thread: Thread) => Thread> {
    const windowOf = await this.windows(grant);
    return thread => fromWindow(thread, windowOf(thread));
  }

  /** A message this grant can see in a thread it can see; one from before it was added is the same 404 as none. */
  private async shownMessage(grant: Grant, thread: Thread, id: number): Promise<ThreadMessage> {
    const message = (await this.viewer(grant))(thread).messages.find(m => m.id === id);
    if (!message) throw new ThreadError(404, `${thread.key} has no message ${id}`);
    return thread.messages.find(m => m.id === id)!;
  }

  private file = (key: string) => join(this.dir, `${key}.json`);
  private get eventsFile() { return join(this.dir, 'events.jsonl'); }

  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  async get(key: string): Promise<Thread | undefined> {
    if (!THREAD_KEY.test(key) || !await exists(this.file(key))) return undefined;
    return readJson(this.file(key), threadSchema);
  }

  /** The thread if this token may see it; otherwise a 404 that does not say whether it exists. */
  async visible(grant: Grant, key: string): Promise<Thread> {
    const thread = await this.get(key);
    if (!thread || !(await this.reader(grant))(thread)) throw new ThreadError(404, `no thread ${key}`);
    return thread;
  }

  private async all(): Promise<Thread[]> {
    if (!await exists(this.dir)) return [];
    const threads: Thread[] = [];
    for (const name of await readdir(this.dir)) {
      const match = name.match(FILE);
      const thread = match ? await this.get(name.slice(0, -5)) : undefined;
      if (thread) threads.push(thread);
    }
    return threads;
  }

  /** Newest activity first. */
  async list(grant: Grant, filter: { project?: string; state?: Thread['state'] } = {}): Promise<Thread[]> {
    const reads = await this.reader(grant);
    return (await this.all())
      .filter(t => reads(t) && (!filter.project || t.project === filter.project) && (!filter.state || t.state === filter.state))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number);
  }

  private writable(grant: Grant, key: string): Project {
    const project = this.project(key);
    if (!project || !this.canSee(grant, key)) throw new ThreadError(404, `no project ${key} for this token`);
    return project;
  }

  /** A message needs text, a launch or a photo, and every launch step must be one the project allows. */
  private checkMessage(input: { text?: string; launches?: Launch[]; photos?: readonly string[] }, project: Project): void {
    if (!input.text && !input.launches?.length && !input.photos?.length) throw new ThreadError(400, 'a message needs text, a launch or a photo');
    const problems = launchProblems(input.launches ?? [], project);
    if (problems.length) throw new ThreadError(400, problems.join('; '));
  }

  /** Every model a launch opens must have been pushed to its project first, so a headset never waits on one that is not there. */
  private async checkModels(launches: readonly Launch[] | undefined, project: Project): Promise<void> {
    const models = modelSteps(launches ?? []);
    if (!models.length) return;
    if (!this.models) throw new ThreadError(400, 'this receiver does not keep 3D models');
    const missing = [];
    for (const m of models) if (!await this.models.has(project.key, m.sha256)) missing.push(m);
    if (missing.length) throw new ThreadError(400, `${missing.map(m => `${m.name} (${m.sha256.slice(0, 12)}…)`).join(', ')} has not been pushed to ${project.key}: send it first with PUT /v1/projects/${project.key}/models/<sha256>, which polycap thread reply --model does`);
  }

  /**
   * The photos a message names, as the store kept them: each must have been sent to the thread's project
   * first, so a message never names one that is not there.
   */
  private async resolvePhotos(ids: readonly string[] | undefined, project: Project, where: string): Promise<Photo[] | undefined> {
    if (!ids?.length) return undefined;
    if (!this.photos) throw new ThreadError(400, 'this receiver does not keep photos');
    if (ids.length > MAX_PHOTOS) throw new ThreadError(400, `a message holds at most ${MAX_PHOTOS} photos`);
    if (new Set(ids).size !== ids.length) throw new ThreadError(400, 'a message names each photo once');
    const photos: Photo[] = [];
    for (const [i, id] of ids.entries()) {
      const found = await this.photos.find(project.key, id);
      if (!found) throw new ThreadError(400, `photos.${i}: ${id.slice(0, 12)}… has not been sent to ${project.key}: send it first with POST ${where}/photos, which polycap thread reply --photo does`);
      photos.push(found.photo);
    }
    return photos;
  }

  /** Counts a change: the thread's seq and activity move on, and the caller commits the returned event. */
  private change(thread: Thread, kind: EventKind, by: Author, message?: number, extra: Partial<Change> = {}): Change {
    const at = new Date().toISOString();
    thread.seq += 1;
    thread.activity.push({
      seq: thread.seq, at, kind, by, ...(message ? { message } : {}), ...(extra.title && (kind === 'recording.words' || kind === 'recording.ready' || kind === 'renamed') ? { title: extra.title } : {}),
      ...(extra.added ? { added: extra.added } : {}), ...(extra.removed ? { removed: extra.removed } : {}),
    });
    thread.updatedAt = at;
    return { at, kind, by, ...(message ? { message } : {}), ...extra };
  }

  private addMessage(thread: Thread, kind: EventKind, by: Author, content: Pick<ThreadMessage, 'text' | 'launches' | 'recording' | 'deliveryId' | 'photos'>): { message: ThreadMessage; event: Change } {
    const id = (thread.messages.at(-1)?.id ?? 0) + 1;
    const event = this.change(thread, kind, by, id, content.photos?.length ? { photos: content.photos.length } : {});
    const message: ThreadMessage = { id, seq: thread.seq, at: event.at, by, ...content, reactions: [], picks: [] };
    thread.messages.push(message);
    return { message, event };
  }

  private async newThread(project: Project, title: string, titleFromRecording: boolean, by: Author, report = false): Promise<Thread> {
    let number = 1;
    for (const name of await exists(this.dir) ? await readdir(this.dir) : []) {
      const match = name.match(FILE);
      if (match?.[1] === project.key) number = Math.max(number, Number(match[2]) + 1);
    }
    const now = new Date().toISOString();
    return {
      version: 1, key: `${project.key}-${number}`, project: project.key, number, title, titleFromRecording, ...(report ? { report: true as const } : {}),
      state: 'open', createdAt: now, updatedAt: now, by, seq: 0, messages: [], activity: [], reads: {},
    };
  }

  /** A thread-scoped grant's new thread lists its person as a member, so only they and the team see it. */
  /**
   * A thread a thread-scoped grant opens has its person in it; one in someone's own project has its owner in it
   * (2026-11-13), so each of the owner's devices is a member whichever opened it.
   */
  private opened(thread: Thread, grant: Grant): Thread {
    if (thread.report) return thread;
    const people = [...new Set([...memberScoped(grant) ? [personId(grant)] : [], ...this.own?.get(thread.project) ? [this.own.get(thread.project)!.owner] : []])];
    if (people.length) thread.members = people.map(person => ({ person, addedBy: thread.by, addedAt: thread.createdAt }));
    return thread;
  }

  /** Writes the thread, then appends and announces its events. */
  private async commit(thread: Thread, changes: Change[]): Promise<Thread> {
    // Empty lists are left out, so a thread nobody named or hid reads as it did before they existed.
    if (!thread.participants?.length) delete thread.participants;
    if (!thread.members?.length) delete thread.members;
    if (thread.hiddenFor && !Object.keys(thread.hiddenFor).length) delete thread.hiddenFor;
    await privateDir(this.dir);
    await writeJsonAtomic(this.file(thread.key), threadSchema.parse(thread));
    const events = await this.events();
    for (const change of changes) {
      const event = eventSchema.parse({ id: (events.at(-1)?.id ?? 0) + 1, thread: thread.key, project: thread.project, ...(thread.report ? { report: true } : {}), ...change });
      await appendFile(this.eventsFile, `${JSON.stringify(event)}\n`, { mode: 0o600 });
      events.push(event);
      this.emitter.emit('event', event);
    }
    return thread;
  }

  /**
   * The team opens a thread with its first message. `members` (the team only) are in it from the first write,
   * so a thread opened for someone (the Welcome, welcome.ts) reaches them whole, never as an empty thread a
   * moment before they are added. A token without `post` (a headset's or a phone's) opens one with photos
   * and optional words, as it posts them (the iPhone's Photo, Robin 2026-11-13); a thread-scoped one is then
   * its member (opened). A `deliveryId` makes a retry the thread already opened, as it does a message.
   */
  create(grant: Grant, input: { project: string; title: string; text?: string; launches?: Launch[]; photos?: string[]; as?: string; members?: readonly string[]; deliveryId?: string }): Promise<Thread> {
    return this.lock(async () => {
      const project = this.writable(grant, input.project);
      if (!grant.scopes.includes('post')) {
        if (input.launches?.length) throw new ThreadError(403, 'sending a launch needs scope post');
        if (!input.photos?.length) throw new ThreadError(403, 'opening a thread with words needs scope post; this token opens one with photos, with or without words, or by recording');
      }
      if (input.deliveryId !== undefined) {
        const parsed = deliveryIdSchema.safeParse(input.deliveryId);
        if (!parsed.success) throw new ThreadError(400, `deliveryId: ${parsed.error.issues.map(i => i.message).join('; ')}`);
        const existing = (await this.all()).find(t => t.messages[0]?.by.id === grant.id && t.messages[0].deliveryId === input.deliveryId);
        if (existing) {
          // The first message and the project, as a reply's retry compares; the title may have been changed since.
          const first = existing.messages[0];
          if (existing.project !== project.key || first.text !== input.text || first.by.as !== input.as || !isDeepStrictEqual(first.launches, input.launches)
            || !isDeepStrictEqual(first.photos?.map(p => p.sha256), input.photos?.length ? input.photos : undefined)) {
            throw new ThreadError(400, 'deliveryId already used for a different thread');
          }
          return existing;
        }
      }
      this.checkMessage(input, project);
      await this.checkModels(input.launches, project);
      const members = [...new Set(input.members ?? [])];
      if (members.length) {
        if (!this.managesProject(grant, project.key)) throw new ThreadError(403, 'only the team, or the project\'s owner in their own, adds people to a thread', { reason: 'not_team' });
        const bad = members.findIndex(person => !PERSON_ID.test(person));
        if (bad >= 0) throw new ThreadError(400, `members.${bad}: a person id is lowercase letters, digits and dashes`);
        if (members.length > MAX_MEMBERS) throw new ThreadError(400, `a thread has at most ${MAX_MEMBERS} members`);
      }
      const photos = await this.resolvePhotos(input.photos, project, `/v1/projects/${project.key}`);
      const by = this.who(grant, input.as);
      const thread = this.opened(await this.newThread(project, input.title, false, by), grant);
      const already = new Set((thread.members ?? []).map(m => m.person));
      if (members.length) thread.members = [...thread.members ?? [], ...members.filter(person => !already.has(person)).map(person => ({ person, addedBy: by, addedAt: thread.createdAt }))];
      const { event } = this.addMessage(thread, 'thread.new', by, { text: input.text, launches: input.launches, ...(photos ? { photos } : {}), deliveryId: input.deliveryId });
      return this.commit(thread, [event]);
    });
  }

  /**
   * The team posts a message; only a new delivery opens a closed thread again. A token without `post` (a
   * headset's or a phone's) may post photos with optional words, never a launch and never words alone.
   */
  post(grant: Grant, key: string, input: { text?: string; launches?: Launch[]; photos?: string[]; as?: string; deliveryId?: string }): Promise<Thread> {
    return this.lock(async () => {
      const thread = await this.visible(grant, key);
      if (!grant.scopes.includes('post')) {
        if (input.launches?.length) throw new ThreadError(403, 'sending a launch needs scope post');
        if (!input.photos?.length) throw new ThreadError(403, 'posting words needs scope post; this token may post photos, with or without words');
      }
      if (input.deliveryId !== undefined) {
        const parsed = deliveryIdSchema.safeParse(input.deliveryId);
        if (!parsed.success) throw new ThreadError(400, `deliveryId: ${parsed.error.issues.map(i => i.message).join('; ')}`);
        const existing = thread.messages.find(m => m.by.id === grant.id && m.deliveryId === input.deliveryId);
        if (existing) {
          // Compare client-controlled content only: a token's label/person may have changed. Object
          // key order (including Android extras) is irrelevant, but launch/step array order matters.
          if (existing.text !== input.text || existing.by.as !== input.as || !isDeepStrictEqual(existing.launches, input.launches)
            || !isDeepStrictEqual(existing.photos?.map(p => p.sha256), input.photos?.length ? input.photos : undefined)) {
            throw new ThreadError(400, 'deliveryId already used for a different reply payload');
          }
          // The thread is the durable receipt, even if commit never reached the event append. No
          // commit here: a retry must not change seq, reads, activity, state or the event feed.
          return thread;
        }
      }
      // Seeing the thread is the right to post in it: a thread-scoped grant may be a member outside its projects.
      const project = this.project(thread.project);
      if (!project) throw new ThreadError(404, `no project ${thread.project} on this receiver`);
      this.checkMessage(input, project);
      await this.checkModels(input.launches, project);
      const photos = await this.resolvePhotos(input.photos, project, `/v1/threads/${key}`);
      const by = this.who(grant, input.as);
      const events: Change[] = [];
      if (thread.state === 'closed') { thread.state = 'open'; events.push(this.change(thread, 'reopened', by)); }
      events.push(this.addMessage(thread, 'message', by, { text: input.text, launches: input.launches, ...(photos ? { photos } : {}), deliveryId: input.deliveryId }).event);
      return this.commit(thread, events);
    });
  }

  /** One reaction per person per message: the same one again takes it back, another replaces it. */
  react(grant: Grant, key: string, messageId: number, reaction: Reaction): Promise<Thread> {
    return this.lock(async () => {
      const thread = await this.visible(grant, key);
      const message = await this.shownMessage(grant, thread, messageId);
      const by = this.who(grant);
      const mine = message.reactions.find(r => r.by.id === by.id);
      message.reactions = message.reactions.filter(r => r.by.id !== by.id);
      const chosen = mine?.reaction === reaction ? null : reaction;
      if (chosen) message.reactions.push({ reaction: chosen, by, at: new Date().toISOString() });
      return this.commit(thread, [this.change(thread, 'reaction', by, messageId, { reaction: chosen })]);
    });
  }

  /**
   * A star on one of a message's options: at most one per person, the same again takes it back and another
   * moves it (2026-10-06, CAP-1 #18). Only a message with options has something to pick between.
   */
  pick(grant: Grant, key: string, messageId: number, launch: number): Promise<Thread> {
    return this.lock(async () => {
      const thread = await this.visible(grant, key);
      const message = await this.shownMessage(grant, thread, messageId);
      const options = message.launches?.length ?? 0;
      if (options < 2) throw new ThreadError(400, `${key} #${messageId} has no options to pick between`);
      if (launch >= options) throw new ThreadError(400, `${key} #${messageId} has ${options} options, so there is no option ${launch + 1}`);
      const by = this.who(grant);
      const mine = message.picks.find(p => p.by.id === by.id);
      message.picks = message.picks.filter(p => p.by.id !== by.id);
      const chosen = mine?.launch === launch ? null : launch;
      if (chosen !== null) message.picks.push({ launch: chosen, by, at: new Date().toISOString() });
      return this.commit(thread, [this.change(thread, 'pick', by, messageId, { launch: chosen })]);
    });
  }

  /** Everything up to seq is seen by this token; never moves backwards. */
  markRead(grant: Grant, key: string, seq: number): Promise<Thread> {
    return this.lock(async () => {
      const thread = await this.visible(grant, key);
      thread.reads[grant.id] = Math.max(thread.reads[grant.id] ?? 0, Math.min(seq, thread.seq));
      return this.commit(thread, []);
    });
  }

  setState(grant: Grant, key: string, state: Thread['state']): Promise<Thread> {
    return this.lock(async () => {
      const thread = await this.visible(grant, key);
      if (thread.state === state) return thread;
      thread.state = state;
      return this.commit(thread, [this.change(thread, state === 'closed' ? 'closed' : 'reopened', this.who(grant))]);
    });
  }

  /**
   * Names people in the thread by email address, or takes them out, for its members only and never in a
   * report. `history` (the team's to choose; else the receiver's default) is whether those added see what came
   * before. The team's additions are emailed by the route (invitations.ts). The `people` event says how many, never who: events.jsonl is kept for
   * ever, so addresses stay out of it. A change that changes nothing is not a change.
   */
  participants(grant: Grant, key: string, change: { add: readonly string[]; remove: readonly string[]; history?: NewMemberHistory }, member: (thread: Thread) => boolean): Promise<Thread> {
    return this.lock(async () => {
      const thread = await this.visible(grant, key);
      if (thread.report) throw new ThreadError(400, 'a report has no participants');
      if (!member(thread)) throw new ThreadError(403, 'only people in this thread can change who is in it', { reason: 'not_member' });
      // The routes have normalised them already; a direct caller gets the same rule, never an echo of the value.
      const normal = (list: readonly string[], name: string) => list.map((value, i) => {
        const parsed = emailSchema.safeParse(value);
        if (!parsed.success) throw new ThreadError(400, `${name}.${i}: ${parsed.error.issues[0].message}`);
        return parsed.data;
      });
      const history = change.history ?? this.history;
      change = { add: normal(change.add, 'add'), remove: normal(change.remove, 'remove') };
      const both = change.remove.findIndex(email => change.add.includes(email));
      if (both >= 0) throw new ThreadError(400, `remove.${both}: also in add`);
      const before = thread.participants ?? [];
      const kept = before.filter(p => !change.remove.includes(p.email));
      const adding = [...new Set(change.add)].filter(email => !kept.some(p => p.email === email));
      const removed = before.length - kept.length;
      if (!adding.length && !removed) return thread;
      if (kept.length + adding.length > MAX_PARTICIPANTS) throw new ThreadError(400, `a thread has at most ${MAX_PARTICIPANTS} participants`);
      const by = this.who(grant);
      const event = this.change(thread, 'people', by, undefined, { ...(adding.length ? { added: adding.length } : {}), ...(removed ? { removed } : {}) });
      thread.participants = [...kept, ...adding.map(email => ({ email, addedBy: by, addedAt: event.at, ...(history === 'visible' ? { history } : {}) }))];
      return this.commit(thread, [event]);
    });
  }

  /**
   * The team adds people to the thread by person id, or takes them out (2026-10-21), choosing with `history` whether
   * those added see what came before (else the receiver's default, 2026-11-12): what lets a thread-scoped
   * grant see it. Never in a report. Out means out: an invitation by a removed person's verified address
   * (`verifiedOf`) goes too, and a thread-scoped grant's own posts never counted. The `people` event says how
   * many, never who. A change that changes nothing is not a change.
   */
  members(grant: Grant, key: string, change: { add: readonly string[]; remove: readonly string[]; history?: NewMemberHistory }, verifiedOf: (person: string) => string | undefined = () => undefined): Promise<Thread> {
    return this.lock(async () => {
      const thread = await this.visible(grant, key);
      if (!this.manages(grant, thread)) throw new ThreadError(403, 'only the team, or the project\'s owner in their own, adds people to a thread or takes them out', { reason: 'not_team' });
      if (thread.report) throw new ThreadError(400, 'a report is the team\'s and has no members');
      const owner = this.own?.get(thread.project)?.owner;
      if (owner && change.remove.includes(owner)) throw new ThreadError(400, `remove.${change.remove.indexOf(owner)}: the project's owner is in every thread of it`);
      for (const [name, list] of [['add', change.add], ['remove', change.remove]] as const) {
        const bad = list.findIndex(person => !PERSON_ID.test(person));
        if (bad >= 0) throw new ThreadError(400, `${name}.${bad}: a person id is lowercase letters, digits and dashes`);
      }
      const both = change.remove.findIndex(person => change.add.includes(person));
      if (both >= 0) throw new ThreadError(400, `remove.${both}: also in add`);
      const before = thread.members ?? [], invited = thread.participants ?? [];
      const kept = before.filter(m => !change.remove.includes(m.person));
      const adding = [...new Set(change.add)].filter(person => !kept.some(m => m.person === person));
      const addresses = new Set(change.remove.flatMap(person => verifiedOf(person) ?? []));
      const stillInvited = invited.filter(p => !addresses.has(p.email));
      const removed = before.length - kept.length + invited.length - stillInvited.length;
      if (!adding.length && !removed) return thread;
      if (kept.length + adding.length > MAX_MEMBERS) throw new ThreadError(400, `a thread has at most ${MAX_MEMBERS} members`);
      const by = this.who(grant);
      const event = this.change(thread, 'people', by, undefined, { ...(adding.length ? { added: adding.length } : {}), ...(removed ? { removed } : {}) });
      const history = change.history ?? this.history;
      thread.members = [...kept, ...adding.map(person => ({ person, addedBy: by, addedAt: event.at, ...(history === 'visible' ? { history } : {}) }))];
      thread.participants = stillInvited;
      return this.commit(thread, [event]);
    });
  }

  /** Takes the thread off this token's inbox until someone else adds to it; no event, and seq stays. */
  hide(grant: Grant, key: string): Promise<Thread> {
    return this.lock(async () => {
      const thread = await this.visible(grant, key);
      thread.hiddenFor = { ...thread.hiddenFor, [grant.id]: thread.seq };
      return this.commit(thread, []);
    });
  }

  unhide(grant: Grant, key: string): Promise<Thread> {
    return this.lock(async () => {
      const thread = await this.visible(grant, key);
      if (thread.hiddenFor?.[grant.id] === undefined) return thread;
      delete thread.hiddenFor[grant.id];
      return this.commit(thread, []);
    });
  }

  rename(grant: Grant, key: string, title: string): Promise<Thread> {
    return this.lock(async () => {
      const thread = await this.visible(grant, key);
      if (thread.title === title) return thread;
      thread.title = title;
      thread.titleFromRecording = false;
      return this.commit(thread, [this.change(thread, 'renamed', this.who(grant), undefined, { title })]);
    });
  }

  /** Refuses an upload's thread reference before the upload exists: unknown thread, project or message. */
  async checkUploadRef(grant: Grant, ref: UploadThreadRef | undefined): Promise<void> {
    if (!ref) { if (!this.projectsFor(grant).length) throw new ThreadError(403, 'this token sees no projects, so a recording has no thread to go in'); return; }
    // Any headset may send a report, whichever projects it sees: the reports project is a drop box.
    if ('report' in ref) { if (!this.reportsOn) throw new ThreadError(409, 'this receiver does not take reports: POLYCAP_REPORTS is not set'); return; }
    if ('project' in ref) { this.writable(grant, ref.project); return; }
    const thread = await this.visible(grant, ref.key);
    if (!ref.replyTo) return;
    const asked = (await this.viewer(grant))(thread).messages.find(m => m.id === ref.replyTo!.message);
    if (!asked) throw new ThreadError(400, `${ref.key} has no message ${ref.replyTo.message}`);
    if (ref.replyTo.launch !== undefined && !asked.launches?.[ref.replyTo.launch]) throw new ThreadError(400, `${ref.key} message ${ref.replyTo.message} has no launch ${ref.replyTo.launch}`);
  }

  /**
   * Puts a recording in its thread, opening one when it names none. Idempotent on the upload: a retried
   * create, or the worker making good a crash, gets the message already there.
   */
  attachRecording(grant: Grant, upload: { id: string; clientId: string; recordedAt?: string }, ref: UploadThreadRef | undefined): Promise<UploadLink> {
    return this.lock(async () => {
      for (const thread of await this.all()) {
        const existing = thread.messages.find(m => m.recording?.uploadId === upload.id);
        if (existing) return { key: thread.key, message: existing.id };
      }
      await this.checkUploadRef(grant, ref);
      const by = this.who(grant);
      if (ref && 'key' in ref) {
        const thread = await this.visible(grant, ref.key);
        const events: Change[] = [];
        if (thread.state === 'closed') { thread.state = 'open'; events.push(this.change(thread, 'reopened', by)); }
        const { message, event } = this.addMessage(thread, 'recording', by, { recording: { uploadId: upload.id, clientId: upload.clientId, ...(ref.replyTo ? { replyTo: ref.replyTo } : {}) } });
        await this.commit(thread, [...events, event]);
        return { key: thread.key, message: message.id };
      }
      const report = isReportRef(ref);
      const project = report ? this.project(this.reports!)! : ref ? this.writable(grant, ref.project) : this.projectsFor(grant)[0];
      const thread = this.opened(await this.newThread(project, provisionalTitle(upload.recordedAt, report ? 'Report' : 'Recording'), true, by, report), grant);
      const { message, event } = this.addMessage(thread, 'thread.new', by, { recording: { uploadId: upload.id, clientId: upload.clientId } });
      await this.commit(thread, [event]);
      return { key: thread.key, message: message.id };
    });
  }

  /** What the session records about its thread. */
  async context(link: UploadLink): Promise<SessionThread | undefined> {
    const thread = await this.get(link.key);
    const message = thread?.messages.find(m => m.id === link.message);
    if (!thread || !message) return undefined;
    const replyTo = message.recording?.replyTo;
    const asked = replyTo ? thread.messages.find(m => m.id === replyTo.message) : undefined;
    const launch = replyTo?.launch !== undefined ? asked?.launches?.[replyTo.launch] : undefined;
    return {
      key: thread.key, project: thread.project, title: thread.title, opened: thread.messages[0].id === message.id,
      ...(replyTo && asked ? { replyTo: { message: replyTo.message, ...(asked.text ? { text: asked.text } : {}), ...(launch ? { launch } : {}) } } : {}),
      ...(thread.report ? { report: true as const } : {}),
    };
  }

  /** The bundle is built, or could not be: the thread hears, and a thread opened by this recording takes its summary's title. */
  recordingFinished(link: UploadLink, outcome: Built | { error: string }): Promise<void> {
    return this.lock(async () => {
      const found = await this.recordingIn(link);
      if (!found) return;
      const { thread, message } = found;
      if ('error' in outcome) { await this.commit(thread, [this.change(thread, 'recording.failed', message.by, message.id, { error: outcome.error.slice(0, 500) })]); return; }
      await this.commit(thread, [this.built(thread, message, 'recording.ready', outcome)]);
    });
  }

  /** Words first: the narration is transcribed and summarised while the video is still uploading. */
  recordingWords(link: UploadLink, outcome: Built): Promise<void> {
    return this.lock(async () => {
      const found = await this.recordingIn(link);
      if (found) await this.commit(found.thread, [this.built(found.thread, found.message, 'recording.words', outcome)]);
    });
  }

  private async recordingIn(link: UploadLink): Promise<{ thread: Thread; message: ThreadMessage } | undefined> {
    const thread = await this.get(link.key);
    const message = thread?.messages.find(m => m.id === link.message);
    return thread && message?.recording ? { thread, message } : undefined;
  }

  /** A thread opened by this recording takes its summary's title, the first time there is one. */
  private built(thread: Thread, message: ThreadMessage, kind: 'recording.words' | 'recording.ready', outcome: Built): Change {
    if (thread.titleFromRecording && outcome.title && thread.messages.find(m => m.recording)?.id === message.id) {
      thread.title = outcome.title.slice(0, 120);
      thread.titleFromRecording = false;
    }
    return this.change(thread, kind, message.by, message.id, {
      sessionId: outcome.sessionId, ...(outcome.title ? { title: outcome.title } : {}), ...(outcome.summary ? { summary: outcome.summary } : {}),
    });
  }

  /** Every event, read once from events.jsonl and kept as it grows; a damaged line is an error, not a gap. */
  private events(): Promise<ThreadEvent[]> {
    this.loaded ??= (async () => {
      if (!await exists(this.eventsFile)) return [];
      return (await readFile(this.eventsFile, 'utf8')).split('\n').filter(Boolean).map((line, i) => {
        const parsed = eventSchema.safeParse(JSON.parse(line));
        if (!parsed.success) throw new Error(`${this.eventsFile} line ${i + 1} is not an event`);
        return parsed.data;
      });
    })();
    return this.loaded;
  }

  async lastEventId(): Promise<number> { return (await this.events()).at(-1)?.id ?? 0; }

  /**
   * The events a grant sees are those of the threads it reads; a thread-scoped grant's, of the threads it is a
   * member of now, and of those only what its view holds: from when it was added (windows), never about a message
   * from before. Message ids only grow, so a message after the first it can see is one it can see.
   */
  private async sees(grant: Grant, after: number, filter: { project?: string; thread?: string }): Promise<(event: ThreadEvent) => boolean> {
    const wanted = (e: ThreadEvent) => e.id > after && (!filter.project || e.project === filter.project) && (!filter.thread || e.thread === filter.thread);
    const scoped = memberScoped(grant);
    // Every event of a project seen whole: the team's projects for the team, and a person's own for them.
    const whole = (e: Pick<ThreadEvent, 'project' | 'report'>) => scoped ? !e.report && this.ownedBy(grant, e.project) : this.canSee(grant, e.project) && (!e.report || isTeam(grant));
    if (!scoped && !this.othersOwn(grant)) return e => wanted(e) && whole(e);
    const windowOf = await this.windows(grant);
    const from = new Map((await this.list(grant)).filter(t => !whole(t)).map(t => {
      const window = windowOf(t);
      const first = window ? fromWindow(t, window).messages[0]?.id ?? (t.messages.at(-1)?.id ?? 0) + 1 : 1;
      return [t.key, { firstMessage: first, at: window?.at }] as const;
    }));
    return e => {
      if (!wanted(e)) return false;
      if (whole(e)) return true;
      const view = from.get(e.thread);
      if (!view) return false;
      return e.message !== undefined ? e.message >= view.firstMessage : !view.at || e.at >= view.at;
    };
  }

  async eventsAfter(grant: Grant, after: number, filter: { project?: string; thread?: string } = {}): Promise<ThreadEvent[]> {
    return (await this.events()).filter(await this.sees(grant, after, filter));
  }

  /** Events after `after`; with none yet, waits up to waitMs for one, or until the client goes away. */
  async waitForEvents(grant: Grant, after: number, filter: { project?: string; thread?: string }, waitMs: number, signal: AbortSignal): Promise<ThreadEvent[]> {
    const now = await this.eventsAfter(grant, after, filter);
    if (now.length || waitMs <= 0 || signal.aborted) return now;
    const sees = await this.sees(grant, after, filter);
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); this.emitter.off('event', onEvent); signal.removeEventListener('abort', finish); resolve(); };
      const onEvent = (event: ThreadEvent) => {
        if (sees(event)) finish();
        // Being added to a thread is a `people` event in a thread this grant could not see a moment ago, and a
        // thread opened with them already in it (the Welcome) is a `thread.new` one.
        else if ((event.kind === 'people' || event.kind === 'thread.new') && (memberScoped(grant) || !this.canSee(grant, event.project))) void this.sees(grant, after, filter).then(now => { if (now(event)) finish(); }, () => undefined);
      };
      const timer = setTimeout(finish, waitMs);
      this.emitter.on('event', onEvent);
      signal.addEventListener('abort', finish);
    });
    return this.eventsAfter(grant, after, filter);
  }
}

