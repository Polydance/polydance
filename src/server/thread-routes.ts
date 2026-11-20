/**
 * The receiver's thread routes (docs/THREADS.md): projects, threads, messages, reactions, read marks,
 * participants, playback and the event feed agents wait on. Changes go through the ThreadStore, which
 * checks every launch against its project; a recording is shown with its upload's live status and its
 * bundle's title and summary. Email addresses are shown only to a thread's members (isMember), and a
 * recording plays only for them and its owner (canPlay). A thread-scoped token (tokens.ts) reaches only the
 * threads it is a member of through any of these routes; the team adds people with POST …/members. Someone
 * added later reads, plays and fetches only what came after they were added (ThreadStore.viewer, 2026-11-12).
 *
 *   GET   /v1/projects                         any      the projects this token sees
 *   POST  /v1/projects                         any      { name, key?, hosts?, packages? }: a project of this token's person's own
 *   GET   /v1/projects/:key                    any      its hosts and packages, for its owner (or the team, for a team project)
 *   POST  /v1/projects/:key                    any      { hosts?, packages? }: the whole new lists, for its owner alone (2026-11-20)
 *   PUT   /v1/projects/:key/models/:sha256     post     a .glb, whole, before a message's launch names it (models.ts)
 *   POST  /v1/projects/:key/photos             upload|post   a JPEG or PNG, whole, before a new thread's message names it (photos.ts)
 *   GET   /v1/threads[?project=&state=]        any      newest activity first, with unread, waiting, people and a snippet; not those this token hid
 *   POST  /v1/threads                          upload|post   { project, title, text?, launches?, photos?, deliveryId? }; with upload only, photos and optional text
 *   GET   /v1/threads/:key                     any      with people, participants (members only) and canPlay
 *   PATCH /v1/threads/:key                     upload|post   { state }, or { title } with post
 *   POST  /v1/threads/:key/state               upload|post   { state }: PATCH's state, for proxies that pass only POST
 *   POST  /v1/threads/:key/title               post     { title }: PATCH's title, for the same proxies
 *   POST  /v1/threads/:key/messages            post     { text?, launches?, photos?, as?, deliveryId? }; with upload only, photos and optional text
 *   POST  /v1/threads/:key/photos              upload|post   a JPEG or PNG, whole, before a message names it
 *   POST  /v1/threads/:key/reactions           upload|post   { message, reaction }
 *   POST  /v1/threads/:key/picks               upload|post   { message, launch }: a star on one of its options
 *   POST  /v1/threads/:key/participants        upload|post   { add?, remove?, resend?, history? }: email addresses, members only, never a report; the team's additions are emailed an invitation (invitations.ts)
 *   POST  /v1/threads/:key/members             post, team    { add?, remove?, history? }: person ids, never a report
 *
 * `history` ("hidden" or "visible", the team's to choose) is whether those added see what came before; without it,
 * POLYCAP_NEW_MEMBER_HISTORY. It is kept with each of them, so changing the setting later reveals nothing (2026-11-12).
 *   POST  /v1/welcome                          post, team    { person, again? }: that person's Welcome thread, opened if they have none (welcome.ts)
 *   POST  /v1/threads/:key/read                any      { seq }
 *   POST  /v1/threads/:key/hide | unhide       any      off this token's inbox until someone else adds to it, or back
 *   GET   /v1/threads/:key/messages/:id/playback      any, canPlay   the recording's transcript and moments, and whether its video is here
 *   GET|HEAD /v1/threads/:key/messages/:id/video      any, canPlay   the video, with single byte ranges
 *   GET|HEAD /v1/threads/:key/models/:sha256  any      a model one of the thread's launches opens, for the headset's viewer
 *   GET|HEAD /v1/threads/:key/photos/:sha256  any, canView   a photo one of the thread's messages holds
 *   GET   /v1/events[?after=N&wait=S&project=&thread=]   any   without after: only the latest id
 *
 * A report's thread (from the bug key) is listed, shown and announced only to the team's tokens. A photo is
 * seen, like a recording, by the thread's members and by whoever posted it (canView).
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { exists } from '../fsx.js';
import { loadSession, SESSION_FILE, sessionDir } from '../session.js';
import { SHA256 } from '../glb.js';
import { MAX_PHOTOS } from '../photo.js';
import { agentNameSchema, editProjectSchema, launchesSchema, modelSteps, newProjectSchema, PROJECT_KEY, projectKeySchema, REACTION_NAMES, THREAD_KEY } from '../threads.js';
import { emailSchema, PERSON_ID, personId, verifiedEmail } from './people.js';
import { playbackView, sendVideo, videoFile } from './playback.js';
import { bundleOf, describeUpload, HttpError, need, parse, readJsonBody, send, type ServerDeps } from './respond.js';
import { canPlay, canView, deliveryIdSchema, fresh, hidden, isMember, isTeam, lastActivity, NEW_MEMBER_HISTORY, photoWords, unread, waiting, type Thread } from './threads.js';
import { teamPeople, type Grant } from './tokens.js';

const text = z.string().trim().min(1).max(4000);
const title = z.string().trim().min(1).max(120);
// `as` is what an agent calls itself ("Opus 5.5"): the message then reads "Opus 5.5 on Robin's Mac".
// Photos are named by the ids the photo routes gave them, each once.
const photos = z.array(z.string().regex(SHA256, 'a photo is named by its sha256, 64 lowercase hex digits')).min(1).max(MAX_PHOTOS)
  .refine(ids => new Set(ids).size === ids.length, 'a message names each photo once');
const newThreadSchema = z.strictObject({ project: projectKeySchema, title, text: text.optional(), launches: launchesSchema.optional(), photos: photos.optional(), as: agentNameSchema.optional(), deliveryId: deliveryIdSchema.optional() });
const messageSchema = z.strictObject({ text: text.optional(), launches: launchesSchema.optional(), photos: photos.optional(), as: agentNameSchema.optional(), deliveryId: deliveryIdSchema.optional() });
const reactionSchema = z.strictObject({ message: z.number().int().positive(), reaction: z.enum(REACTION_NAMES) });
const pickSchema = z.strictObject({ message: z.number().int().positive(), launch: z.number().int().nonnegative() });
const readSchema = z.strictObject({ seq: z.number().int().nonnegative() });
const patchSchema = z.strictObject({ state: z.enum(['open', 'closed']).optional(), title: title.optional() });
const stateSchema = z.strictObject({ state: z.enum(['open', 'closed']) });
const titleSchema = z.strictObject({ title });
const addresses = z.array(emailSchema).max(20);
const history = z.enum(NEW_MEMBER_HISTORY).optional();
const participantsSchema = z.strictObject({ add: addresses.optional(), remove: addresses.optional(), resend: addresses.optional(), history });
const persons = z.array(z.string().trim().toLowerCase().regex(PERSON_ID, 'a person id is lowercase letters, digits and dashes')).max(20);
const membersSchema = z.strictObject({ add: persons.optional(), remove: persons.optional(), history });
const welcomeSchema = z.strictObject({ person: z.string().trim().toLowerCase().regex(PERSON_ID, 'a person id is lowercase letters, digits and dashes'), again: z.boolean().optional() });
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Whether additions by this token are emailed an invitation (2026-11-10): the team's, meaning a team token or
 * any device of a person who holds one (Robin's headset and phone, whose tokens are upload only). Anyone else's
 * are recorded and never emailed, so nobody can use Polydance to email strangers.
 */
const invites = (deps: ServerDeps, grant: Grant) => isTeam(grant) || teamPeople(deps.grants).has(personId(grant));

/** What a participant's line says about email: sent, on its way, or why not. */
async function emailStates(deps: ServerDeps, thread: Thread): Promise<(p: NonNullable<Thread['participants']>[number]) => object> {
  if (!deps.invitations) return () => ({ emailed: false, emailNote: 'this receiver does not send email' });
  const statuses = await deps.invitations.statuses(thread.key);
  const team = teamPeople(deps.grants);
  return p => {
    const status = statuses.get(p.email);
    if (status) return status;
    const byTeam = team.has(p.addedBy.user?.id ?? p.addedBy.id) || deps.grants.some(g => g.id === p.addedBy.id && isTeam(g));
    return { emailed: false, emailNote: byTeam ? 'added before this receiver sent email' : 'only addresses the team adds are emailed' };
  };
}

/** A thread as a client sees it: addresses only for a member, and whether each recording plays for this token. */
async function threadView(deps: ServerDeps, grant: Grant, full: Thread): Promise<object> {
  const thread = (await deps.threads.viewer(grant))(full);
  const emails = await deps.people.emails();
  const mine = verifiedEmail(emails, grant);
  const member = isMember(grant, thread, mine);
  const emailState = member && thread.participants?.length ? await emailStates(deps, thread) : () => ({ emailed: false });
  const messages = [];
  for (const message of thread.messages) {
    if (!message.recording) { messages.push(message.photos ? { ...message, canView: canView(grant, thread, message, mine) } : message); continue; }
    const record = await deps.store.get(message.recording.uploadId);
    const live = record ? await describeUpload(deps, record) : { status: 'deleted' };
    const { status, sessionId, title: label, summary, steps, durationMs, error, deletedReason, content } = live;
    // Which of the answered message's options the recording put on screen, in order, from its launch log.
    const answers = message.recording.replyTo?.message;
    const tried = [...new Set((record?.opened ?? []).flatMap(o => o.launch !== undefined && answers !== undefined && (o.message ?? answers) === answers ? [o.launch] : []))];
    messages.push({
      ...message, recording: {
        ...message.recording, status, sessionId, title: label, summary, steps, durationMs, error, deletedReason, ...(tried.length ? { tried } : {}),
        // What there is to play (a picture, sound alone, or nothing: logs alone), and whether it has logs (docs/LOGS.md).
        ...(content ? { content } : {}), ...(record?.logs ? { logs: true } : {}),
        canPlay: canPlay(grant, thread, record?.grantId, mine),
      },
    });
  }
  const participants = thread.participants ?? [];
  return {
    me: grant.id, key: thread.key, project: { key: thread.project, name: deps.threads.project(thread.project)?.name ?? thread.project },
    title: thread.title, state: thread.state, createdAt: thread.createdAt, updatedAt: thread.updatedAt, by: thread.by, ...(thread.report ? { report: true } : {}),
    seq: thread.seq, readSeq: thread.reads[grant.id] ?? 0, unread: unread(thread, grant.id), waiting: waiting(thread, grant.id), ...(hidden(thread, grant.id) ? { hidden: true } : {}),
    member, canPlay: member, people: deps.people.inThread(thread, emails, member), participantCount: participants.length,
    ...(member ? { participants: participants.map(p => ({ email: p.email, addedBy: p.addedBy.display ?? p.addedBy.name, addedAt: p.addedAt, ...(deps.threads.manages(grant, thread) && p.history ? { history: p.history } : {}), ...emailState(p) })) } : {}),
    // Person ids can be Meta's or Google's ids for someone: the team's to see, as it is the team's to change.
    ...(deps.threads.manages(grant, thread) ? { members: (thread.members ?? []).map(m => ({ person: m.person, name: deps.people.user(m.person)?.name ?? m.person, addedBy: m.addedBy.display ?? m.addedBy.name, addedAt: m.addedAt, ...(m.history ? { history: m.history } : {}) })) } : {}),
    messages,
  };
}

/** The inbox's preview line: the newest message's words, or the newest recording's summary; else what happened last. */
async function snippet(deps: ServerDeps, thread: Thread): Promise<string> {
  for (const message of [...thread.messages].reverse()) {
    let words = message.text ?? (message.photos ? photoWords(message.photos.length) : undefined);
    if (!words && message.recording) {
      const record = await deps.store.get(message.recording.uploadId);
      words = record && (await bundleOf(deps, record))?.summary?.text;
    }
    if (words?.trim()) return words.replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  return lastActivity(thread).text;
}

/**
 * The recording a message is, for a token that may play it: its upload, bundle folder and manifest. Access
 * is checked before anything about the upload is said; then a deleted one, or one with no bundle yet, is a
 * 404 that says which.
 */
async function playable(deps: ServerDeps, grant: Grant, thread: Thread, id: string) {
  const message = /^[1-9][0-9]{0,8}$/.test(id) ? thread.messages.find(m => m.id === Number(id)) : undefined;
  if (!message) throw new HttpError(404, `${thread.key} has no message ${id}`);
  if (!message.recording) throw new HttpError(404, `${thread.key} #${message.id} is not a recording`, { reason: 'no_recording' });
  const record = await deps.store.get(message.recording.uploadId);
  if (!canPlay(grant, thread, record?.grantId, verifiedEmail(await deps.people.emails(), grant))) {
    throw new HttpError(403, 'only people in this thread can play its recordings', { reason: 'not_member' });
  }
  if (!record || record.status === 'deleted') throw new HttpError(404, 'this recording was deleted', { reason: 'deleted' });
  const dir = record.sessionId && SESSION_ID.test(record.sessionId) ? sessionDir(deps.config, record.sessionId) : undefined;
  if (!dir || !await exists(join(dir, SESSION_FILE))) throw new HttpError(404, 'this recording has no bundle yet', { reason: 'not_yet' });
  return { message, record, dir, manifest: await loadSession(dir) };
}

/** Keeps the request's body as a photo of `project` and answers: 201 when kept, 200 when it was here already. */
async function photoPut(deps: ServerDeps, grant: Grant, project: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { created, ...photo } = await deps.threads.photos!.put(project, Number(req.headers['content-length']), req.headers['content-type'], req);
  if (created) deps.log(`photo ${project}/${photo.sha256.slice(0, 12)} sent by ${grant.id} (${photo.bytes} bytes)`);
  send(res, created ? 201 : 200, { project, ...photo });
}

/** Key and name; a project of the token's person's own (2026-11-13) says so with `mine`. */
const projectsView = (deps: ServerDeps, grant: Grant) => deps.threads.projectsFor(grant).map(p => ({ key: p.key, name: p.name, ...(deps.threads.ownedBy(grant, p.key) ? { mine: true } : {}) }));

/** Handles the request when it is one of these routes; false otherwise. */
export async function threadRoutes(req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], grant: Grant | undefined, deps: ServerDeps): Promise<boolean> {
  const { threads } = deps;
  const any = () => need(grant, 'upload', 'read', 'post');

  // The team opens someone's Welcome by hand: anyone who signed in before it was on, a token's person, or
  // Robin trying it on his own headset. Signing in opens it by itself (http.ts).
  if (parts[1] === 'welcome' && parts.length === 2 && req.method === 'POST') {
    const g = need(grant, 'post');
    if (!isTeam(g)) throw new HttpError(403, 'only the team opens a Welcome for someone', { reason: 'not_team' });
    if (!deps.welcome) throw new HttpError(409, 'this receiver has no Welcome: POLYCAP_WELCOME is not set');
    const input = parse(welcomeSchema, await readJsonBody(req));
    if (!deps.people.knows(input.person, deps.grants)) throw new HttpError(400, 'nobody on this receiver has that person id (POLYCAP_USERS, a tester\'s mapping, or a token\'s id)');
    const name = deps.people.user(input.person)?.name;
    const welcomed = await deps.welcome.ensure(input.person, name, { again: input.again });
    send(res, welcomed.opened ? 201 : 200, welcomed);
    return true;
  }

  if (parts[1] === 'projects' && parts.length === 2 && req.method === 'GET') {
    const g = any();
    // reports-v1: this receiver takes reports from the bug key (POLYCAP_REPORTS); models-v1: launches may open 3D models;
    // projects-new-v1: POST /v1/projects makes a project of your own, so the apps offer New project.
    send(res, 200, {
      me: g.id, projects: projectsView(deps, g),
      capabilities: [
        'idempotent-replies-v1', ...(threads.reportsOn ? ['reports-v1'] : []), ...(threads.models ? ['models-v1'] : []), ...(threads.photos ? ['photos-v1'] : []),
        ...(threads.enabled && threads.own ? ['projects-new-v1', 'projects-edit-v1'] : []),
        // agents-v1: a device asks for a code its person types into `polycap connect` (agents.ts), so the apps offer Connect your agent.
        ...(deps.agents ? ['agents-v1'] : []),
      ],
    });
    return true;
  }

  // Anyone may make a project of their own (Robin, 2026-11-13), up to MAX_OWN_PROJECTS; only they see it whole.
  if (parts[1] === 'projects' && parts.length === 2 && req.method === 'POST') {
    const g = any();
    const project = await threads.createProject(g, parse(newProjectSchema, await readJsonBody(req)));
    deps.log(`project ${project.key} made by ${g.id}`);
    send(res, 201, { me: g.id, project: { key: project.key, name: project.name, mine: true, hosts: project.hosts, packages: project.packages }, projects: projectsView(deps, g) });
    return true;
  }

  // A project's hosts and packages: read by whoever may send its launches, changed by its owner alone (2026-11-20).
  // Keys are upper case, as every other route takes them; anything else is the 404 of a key nobody has used.
  if (parts[1] === 'projects' && parts.length === 3 && (req.method === 'GET' || req.method === 'POST')) {
    const g = any();
    const key = parts[2];
    if (!PROJECT_KEY.test(key)) throw new HttpError(404, `no project ${key.slice(0, 20)} for this token`);
    const mine = () => (threads.ownedBy(g, key) ? { mine: true } : {});
    if (req.method === 'GET') {
      const project = threads.describeProject(g, key);
      send(res, 200, { me: g.id, project: { key: project.key, name: project.name, ...mine(), hosts: project.hosts, packages: project.packages } });
      return true;
    }
    const project = await threads.editProject(g, key, parse(editProjectSchema, await readJsonBody(req)));
    deps.log(`project ${project.key} changed by ${g.id}: ${project.hosts.length} host(s), ${project.packages.length} package(s)`);
    send(res, 200, { me: g.id, project: { key: project.key, name: project.name, mine: true, hosts: project.hosts, packages: project.packages } });
    return true;
  }

  if (parts[1] === 'projects' && parts.length === 4 && parts[3] === 'photos' && req.method === 'POST') {
    // An upload token sends photos for a thread it opens with them (the iPhone's Photo, 2026-11-13).
    const g = need(grant, 'upload', 'post');
    const project = parts[2];
    if (!threads.photos) throw new HttpError(404, 'this receiver does not keep photos');
    if (!threads.projectsFor(g).some(p => p.key === project)) throw new HttpError(404, `no project ${project} for this token`);
    await photoPut(deps, g, project, req, res);
    return true;
  }

  if (parts[1] === 'projects' && parts.length === 5 && parts[3] === 'models' && req.method === 'PUT') {
    const g = need(grant, 'post');
    if (!threads.models) throw new HttpError(404, 'this receiver does not keep 3D models');
    const project = parts[2];
    if (!threads.projectsFor(g).some(p => p.key === project)) throw new HttpError(404, `no project ${project} for this token`);
    if (!SHA256.test(parts[4])) throw new HttpError(400, 'a model is named by its sha256, 64 lowercase hex digits');
    const stored = await threads.models.put(project, parts[4], Number(req.headers['content-length']), req);
    if (stored.created) deps.log(`model ${project}/${stored.sha256.slice(0, 12)} pushed by ${g.id} (${stored.bytes} bytes)`);
    send(res, stored.created ? 201 : 200, { project, sha256: stored.sha256, bytes: stored.bytes });
    return true;
  }

  if (parts[1] === 'events' && parts.length === 2 && req.method === 'GET') {
    const g = any();
    const filter = { project: url.searchParams.get('project') ?? undefined, thread: url.searchParams.get('thread') ?? undefined };
    if (url.searchParams.get('after') === null) { send(res, 200, { me: g.id, events: [], last: await threads.lastEventId() }); return true; }
    const after = Number(url.searchParams.get('after'));
    const wait = Number(url.searchParams.get('wait') ?? 0);
    if (!Number.isInteger(after) || after < 0) throw new HttpError(400, 'after must be an event id, a whole number');
    if (!Number.isFinite(wait) || wait < 0 || wait > 30) throw new HttpError(400, 'wait is seconds, from 0 to 30');
    const gone = new AbortController();
    res.once('close', () => gone.abort());
    const events = await threads.waitForEvents(g, after, filter, wait * 1000, gone.signal);
    if (res.destroyed) return true;
    send(res, 200, { me: g.id, events, last: events.at(-1)?.id ?? after });
    return true;
  }

  if (parts[1] !== 'threads') return false;
  if (req.method !== 'GET' && req.method !== 'HEAD' && !threads.enabled) throw new HttpError(409, 'threads are off on this receiver: POLYCAP_PROJECTS is not set');

  if (parts.length === 2 && req.method === 'GET') {
    const g = any();
    const project = url.searchParams.get('project') ?? undefined, state = url.searchParams.get('state') ?? undefined;
    if (project !== undefined && !PROJECT_KEY.test(project)) throw new HttpError(400, 'project must be a project key such as MUS');
    if (state !== undefined && state !== 'open' && state !== 'closed') throw new HttpError(400, 'state must be open or closed');
    // A thread this token hid stays out, unread count included, until someone else adds to it.
    const view = await threads.viewer(g);
    const inbox = (await threads.list(g)).map(view).filter(t => !hidden(t, g.id));
    const emails = await deps.people.emails();
    const mine = verifiedEmail(emails, g);
    send(res, 200, {
      // reports: whether the headset's bug key has somewhere to send to.
      me: g.id, projects: projectsView(deps, g), unread: inbox.filter(t => unread(t, g.id)).length, reports: threads.reportsOn,
      // The apps' New project (2026-11-13) reads this here, as the bug key reads reports, rather than asking /v1/projects too.
      newProjects: threads.enabled && threads.own !== undefined,
      // And whether a device may ask for a code to connect its person's agent (agents.ts, 2026-11-20): the inbox then offers it.
      agents: deps.agents !== undefined,
      threads: await Promise.all(inbox.filter(t => (!project || t.project === project) && (!state || t.state === state)).map(async t => {
        const people = deps.people.inThread(t, emails, isMember(g, t, mine));
        return {
          key: t.key, project: t.project, title: t.title, state: t.state, createdAt: t.createdAt, updatedAt: t.updatedAt, by: t.by, ...(t.report ? { report: true } : {}),
          messages: t.messages.length, seq: t.seq, unread: unread(t, g.id), waiting: waiting(t, g.id), fresh: fresh(t, g.id), last: lastActivity(t),
          people: people.slice(0, 6), peopleCount: people.length, snippet: await snippet(deps, t), lastMessageAt: t.messages.at(-1)?.at ?? t.createdAt,
        };
      })),
    });
    return true;
  }
  if (parts.length === 2 && req.method === 'POST') {
    // An upload token opens a thread with photos and optional words; the store refuses it anything else.
    const g = need(grant, 'upload', 'post');
    const thread = await threads.create(g, parse(newThreadSchema, await readJsonBody(req)));
    send(res, 201, await threadView(deps, g, thread));
    return true;
  }

  const key = parts[2];
  if (!key || !THREAD_KEY.test(key)) throw new HttpError(404, 'no such thread');
  if (parts.length === 3 && req.method === 'GET') {
    const g = any();
    send(res, 200, await threadView(deps, g, await threads.visible(g, key)));
    return true;
  }
  if (parts.length === 3 && req.method === 'PATCH') {
    const g = need(grant, 'upload', 'post');
    const input = parse(patchSchema, await readJsonBody(req));
    if (!input.state && !input.title) throw new HttpError(400, 'say state or title');
    if (input.title && !g.scopes.includes('post')) throw new HttpError(403, 'renaming a thread needs scope post');
    let thread = await threads.visible(g, key);
    if (input.title) thread = await threads.rename(g, key, input.title);
    if (input.state) thread = await threads.setState(g, key, input.state);
    send(res, 200, await threadView(deps, g, thread));
    return true;
  }
  if (parts.length === 4 && req.method === 'POST') {
    if (parts[3] === 'photos') {
      const g = need(grant, 'upload', 'post');
      if (!threads.photos) throw new HttpError(404, 'this receiver does not keep photos');
      // Seeing the thread is the right to send it a photo: a tester's thread may be outside its projects.
      const thread = await threads.visible(g, key);
      await photoPut(deps, g, thread.project, req, res);
      return true;
    }
    if (parts[3] === 'messages') {
      // An upload token posts photos with optional words; the store refuses it anything else.
      const g = need(grant, 'upload', 'post');
      send(res, 201, await threadView(deps, g, await threads.post(g, key, parse(messageSchema, await readJsonBody(req)))));
      return true;
    }
    if (parts[3] === 'reactions') {
      const g = need(grant, 'upload', 'post');
      const input = parse(reactionSchema, await readJsonBody(req));
      send(res, 200, await threadView(deps, g, await threads.react(g, key, input.message, input.reaction)));
      return true;
    }
    if (parts[3] === 'picks') {
      const g = need(grant, 'upload', 'post');
      const input = parse(pickSchema, await readJsonBody(req));
      send(res, 200, await threadView(deps, g, await threads.pick(g, key, input.message, input.launch)));
      return true;
    }
    if (parts[3] === 'read') {
      const g = any();
      send(res, 200, await threadView(deps, g, await threads.markRead(g, key, parse(readSchema, await readJsonBody(req)).seq)));
      return true;
    }
    if (parts[3] === 'state') {
      const g = need(grant, 'upload', 'post');
      send(res, 200, await threadView(deps, g, await threads.setState(g, key, parse(stateSchema, await readJsonBody(req)).state)));
      return true;
    }
    if (parts[3] === 'title') {
      const g = need(grant, 'post');
      send(res, 200, await threadView(deps, g, await threads.rename(g, key, parse(titleSchema, await readJsonBody(req)).title)));
      return true;
    }
    if (parts[3] === 'participants') {
      const g = need(grant, 'upload', 'post');
      const input = parse(participantsSchema, await readJsonBody(req));
      if (!input.add?.length && !input.remove?.length && !input.resend?.length) throw new HttpError(400, 'say add, remove or resend, with at least one address');
      if (input.history && !input.add?.length) throw new HttpError(400, 'history goes with add: it is whether the people added see what came before');
      const emails = await deps.people.emails();
      const mine = verifiedEmail(emails, g);
      const before = await threads.visible(g, key);
      if (input.resend?.length) {
        if (!deps.invitations) throw new HttpError(409, 'this receiver does not send email: POLYCAP_MAIL is not set');
        if (!invites(deps, g) || !isMember(g, before, mine)) throw new HttpError(403, 'only the team sends invitations again', { reason: 'not_team' });
        const missing = input.resend.findIndex(email => !(before.participants ?? []).some(p => p.email === email));
        if (missing >= 0) throw new HttpError(400, `resend.${missing}: not in this thread; add it instead`);
      }
      // Showing someone what came before is the team's choice (Robin's devices included), or the owner's in their own project.
      if (input.history && !invites(deps, g) && !threads.manages(g, before)) throw new HttpError(403, 'only the team, or the project\'s owner in their own, chooses whether the people added see what came before', { reason: 'not_team' });
      const thread = input.add?.length || input.remove?.length
        ? await threads.participants(g, key, { add: input.add ?? [], remove: input.remove ?? [], history: input.history }, t => isMember(g, t, mine))
        : before;
      // The team's new addresses each get one invitation for this thread; a resend is the team asking again.
      if (deps.invitations && invites(deps, g)) {
        const had = new Set((before.participants ?? []).map(p => p.email));
        const added = (thread.participants ?? []).filter(p => !had.has(p.email)).map(p => p.email);
        const about = { key: thread.key, title: thread.title, project: threads.project(thread.project)?.name ?? thread.project };
        const by = deps.people.person(g).name;
        const known = (email: string) => Object.values(emails).some(e => e.verified && e.email === email);
        for (const email of added) await deps.invitations.invite(email, about, by, { known: known(email) });
        for (const email of input.resend ?? []) await deps.invitations.invite(email, about, by, { known: known(email), again: true });
      }
      send(res, 200, await threadView(deps, g, thread));
      return true;
    }
    if (parts[3] === 'members') {
      // A project's owner manages its threads from whichever device (2026-11-13); in the team's projects only the team does.
      const g = need(grant, 'upload', 'post');
      const input = parse(membersSchema, await readJsonBody(req));
      if (!input.add?.length && !input.remove?.length) throw new HttpError(400, 'say add or remove, with at least one person id');
      if (input.history && !input.add?.length) throw new HttpError(400, 'history goes with add: it is whether the people added see what came before');
      // A thread it cannot see is a 404 before anything is said about people.
      if (!threads.manages(g, await threads.visible(g, key))) throw new HttpError(403, 'only the team, or the project\'s owner in their own, adds people to a thread or takes them out', { reason: 'not_team' });
      // Only someone the receiver knows, so a typo is an error rather than a member who never arrives.
      const unknown = (input.add ?? []).findIndex(person => !deps.people.knows(person, deps.grants));
      if (unknown >= 0) throw new HttpError(400, `add.${unknown}: nobody on this receiver has that person id (POLYCAP_USERS, a tester's mapping, or a token's id)`);
      const emails = await deps.people.emails();
      const thread = await threads.members(g, key, { add: input.add ?? [], remove: input.remove ?? [], history: input.history }, person => emails[person]?.verified ? emails[person].email : undefined);
      send(res, 200, await threadView(deps, g, thread));
      return true;
    }
    if (parts[3] === 'hide' || parts[3] === 'unhide') {
      const g = any();
      req.resume();
      send(res, 200, await threadView(deps, g, await (parts[3] === 'hide' ? threads.hide(g, key) : threads.unhide(g, key))));
      return true;
    }
  }
  if (parts.length === 5 && parts[3] === 'models' && (req.method === 'GET' || req.method === 'HEAD')) {
    const g = any();
    const thread = (await threads.viewer(g))(await threads.visible(g, key));
    // Only a model this thread's launches open: a token reaches models through threads it may see, never by hash alone.
    const named = thread.messages.some(m => modelSteps(m.launches ?? []).some(step => step.sha256 === parts[4]));
    if (!named || !threads.models || !await threads.models.has(thread.project, parts[4])) throw new HttpError(404, `${key} opens no model ${parts[4].slice(0, 12)}`);
    const file = threads.models.path(thread.project, parts[4]);
    const { size } = await stat(file);
    res.writeHead(200, { 'content-type': 'model/gltf-binary', 'content-length': size, etag: `"${parts[4]}"`, 'cache-control': 'private, max-age=31536000, immutable' });
    if (req.method === 'HEAD') { res.end(); return true; }
    await pipeline(createReadStream(file), res);
    return true;
  }
  if (parts.length === 5 && parts[3] === 'photos' && (req.method === 'GET' || req.method === 'HEAD')) {
    const g = any();
    const thread = (await threads.viewer(g))(await threads.visible(g, key));
    // Only a photo this thread's messages hold: a token reaches photos through threads it may see, never by id alone.
    const message = thread.messages.find(m => m.photos?.some(p => p.sha256 === parts[4]));
    const found = message && threads.photos ? await threads.photos.locate(thread.project, parts[4]) : undefined;
    if (!message || !found) throw new HttpError(404, `${key} holds no photo ${parts[4].slice(0, 12)}`);
    if (!canView(g, thread, message, verifiedEmail(await deps.people.emails(), g))) throw new HttpError(403, 'only people in this thread can see its photos', { reason: 'not_member' });
    res.writeHead(200, {
      'content-type': found.type, 'content-length': found.bytes, etag: `"${parts[4]}"`, 'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=31536000, immutable',
    });
    if (req.method === 'HEAD') { res.end(); return true; }
    await pipeline(createReadStream(found.file), res);
    return true;
  }
  if (parts.length === 6 && parts[3] === 'messages' && (parts[5] === 'playback' || parts[5] === 'video')) {
    const video = parts[5] === 'video';
    if (req.method !== 'GET' && !(video && req.method === 'HEAD')) throw new HttpError(404, 'not found');
    const g = any();
    const found = await playable(deps, g, (await threads.viewer(g))(await threads.visible(g, key)), parts[4]);
    if (!video) {
      send(res, 200, await playbackView(found.dir, found.manifest, found.record, { key, message: found.message.id }));
      return true;
    }
    const file = await videoFile(found.dir, found.manifest);
    if (!file) throw new HttpError(404, 'the video has not arrived yet', { reason: 'not_yet' });
    await sendVideo(req, res, file);
    return true;
  }
  throw new HttpError(404, 'not found');
}
