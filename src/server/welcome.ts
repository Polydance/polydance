/**
 * The Welcome (Robin, 2026-11-10): someone new who signs in opens Polydance to a thread already waiting for
 * them, not an empty inbox. A thread-scoped tester sees only threads they are a member of, so before this the
 * first thing they saw was "No threads yet". The receiver opens "Welcome to Polydance" in its welcome project
 * (POLYCAP_WELCOME, off when unset) with them as its only member: what a thread is, and a launch that records
 * while it opens the getting-started page (/start, start.ts). When their first recording there is built,
 * Polydance follows up once with what it made of it and what to do next.
 *
 * Polydance writes as an agent of its own (`as: "Polydance"`, so the headset draws a rounded square) through a
 * grant that is never a token: nobody can sign in as it. Which person was welcomed in which thread is kept in
 * welcome.json beside people.json (0600), so signing in again, a new headset, or a restart never opens a second
 * one. Both steps are idempotent: a thread the receiver wrote but did not get to record is found and adopted,
 * and the follow-up is looked for before it is posted, so the start-up sweep can make good a crash in between.
 */
import { join } from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.js';
import { exists, readJson, writeJsonAtomic } from '../fsx.js';
import { loadSession, requestsFileSchema, sessionDir, sessionPaths } from '../session.js';
import { formatClock } from '../time.js';
import { isHttpsUrl, launchProblems, projectKeySchema, threadKeySchema, type Launch, type Project } from '../threads.js';
import { PERSON_ID } from './people.js';
import type { Author, Thread, ThreadStore, UploadLink } from './threads.js';
import type { Grant } from './tokens.js';
import type { UploadStore } from './uploads.js';

/** Polydance's own id and name: reserved, so no token or user can be it (serve.ts, token.ts). */
export const WELCOME_ID = 'polydance';
const NAME = 'Polydance';
const TITLE = 'Welcome to Polydance';
/** The follow-up's delivery id: one per thread, which is what makes posting it twice impossible. */
const NEXT = 'welcome-next';

/** Writes the Welcome. Not a token: it is in no grant list, so no request can ever authenticate as it. */
const AUTHOR: Grant = { id: WELCOME_ID, sha256: '0'.repeat(64), scopes: ['post'], label: NAME };

/** POLYCAP_WELCOME: the project the Welcome opens in, and the getting-started page its launch opens. */
export const welcomeSettingsSchema = z.strictObject({
  project: projectKeySchema,
  url: z.string().max(2000).refine(isHttpsUrl, 'must be an https link'),
});
export type WelcomeSettings = z.infer<typeof welcomeSettingsSchema>;

/** Unset means off; anything else must be a whole, working setting, or the receiver does not start. */
export function parseWelcome(raw: string | undefined, projects: readonly Project[]): WelcomeSettings | undefined {
  if (!raw?.trim()) return undefined;
  let json: unknown;
  try { json = JSON.parse(raw); } catch { throw new Error('POLYCAP_WELCOME is not JSON: {"project":"START","url":"https://…/start"}'); }
  const parsed = welcomeSettingsSchema.safeParse(json);
  if (!parsed.success) throw new Error(`POLYCAP_WELCOME: ${parsed.error.issues.map(i => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ')}`);
  const project = projects.find(p => p.key === parsed.data.project);
  if (!project) throw new Error(`POLYCAP_WELCOME names project ${parsed.data.project}, which POLYCAP_PROJECTS does not have`);
  const problems = launchProblems([launchFor(parsed.data)], project);
  if (problems.length) throw new Error(`POLYCAP_WELCOME: ${problems.join('; ')} (add its host to the ${project.key} project's hosts)`);
  return parsed.data;
}

const launchFor = (settings: WelcomeSettings): Launch => ({ label: 'Getting started', steps: [{ do: 'open', url: settings.url }] });

const entrySchema = z.strictObject({ person: z.string().regex(PERSON_ID), key: threadKeySchema, at: z.string() });
const fileSchema = z.strictObject({ version: z.literal(1), threads: z.array(entrySchema) });
type Entry = z.infer<typeof entrySchema>;

/** A message's person: their user, else the token (people.ts personId, from the author a message keeps). */
const personOf = (by: Author) => by.user?.id ?? by.id;

/** The first message: what a thread is, and the launch that tries it. Plain words; the headset shows them as written. */
export function hello(name: string | undefined): string {
  // "Tester" is what sign-in calls someone whose headset gave no name: better no name than that one.
  const first = name?.trim() === 'Tester' ? undefined : name?.trim().split(/\s+/)[0];
  return [
    `Hi${first ? ` ${first}` : ''}, welcome to Polydance.`,
    'This is a thread: one piece of work, oldest message first, like an email conversation. People and their coding agents post messages here, and you answer by recording what you see and say in the headset.',
    'Try it now: press Record and open. Polydance starts recording and opens the getting-started page. Look round it and say what is unclear or missing. Point at things and say "this"; say "bug" when something is wrong and "it would be nice" for an idea. Then come back here and press Stop.',
    'One more thing: tap the circle in the corner and add your email address. Polydance emails you a link to confirm it, and then people can invite you to their threads by address.',
  ].join('\n\n');
}

/** What Polydance made of a recording, in a few lines: its title and sentence, and how many requests, with the first. */
export interface Heard { title?: string; summary?: string; durationMs?: number; requests: { atMs: number; text: string }[] }

/** The follow-up. Deterministic for the same recording, so a sweep after a crash writes what the worker would have. */
export function next(heard: Heard | undefined, url: string): string {
  const parts: string[] = [];
  if (heard?.title) {
    parts.push(`Here is what Polydance made of your recording: "${heard.title}".${heard.summary ? ` ${heard.summary}` : ''}`);
    const [first] = heard.requests;
    const quoted = first && `"${first.text.length > 200 ? `${first.text.slice(0, 199)}…` : first.text}"`;
    parts.push(!first ? 'It found no requests in it, which is fine for a first try.'
      : heard.requests.length === 1 ? `It found one request, at ${formatClock(first.atMs)}: ${quoted}`
        : `It found ${heard.requests.length} requests; the first, at ${formatClock(first.atMs)}: ${quoted}`);
  } else {
    parts.push(`Polydance has your recording${heard?.durationMs ? ` (${formatClock(heard.durationMs)})` : ''}: its transcript, the frames from the moments you pointed, and the requests in your words.`);
  }
  parts.push('That is what a coding agent reads. In a real thread, the agent answers here with the next version for you to try, and you answer that by recording again.');
  parts.push([
    'What next:',
    '- When someone adds you to one of their threads, it appears in your inbox.',
    '- To start something of your own, press New thread and describe it as you record.',
    '- Turn on reply notices behind the gear, so you hear when someone answers.',
    // The headset draws Connect your agent under this message when it can (Agents.kt, isWelcomeAnswer): it finds it by `welcome-next`.
    `- Connect your own coding agent, so it reads recordings like this one and answers with builds to try. The getting-started page says how: ${url}#your-agent`,
  ].join('\n'));
  return parts.join('\n\n');
}

export class Welcome {
  private readonly file: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    dir: string, readonly settings: WelcomeSettings, private readonly threads: ThreadStore,
    private readonly uploads: UploadStore, private readonly config: Config,
  ) { this.file = join(dir, 'welcome.json'); }

  /** One step at a time: two sign-ins from one person's two headsets must not open two threads. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Read fresh each time: small, and a damaged file is an error rather than nobody welcomed. */
  private async entries(): Promise<Entry[]> { return await exists(this.file) ? (await readJson(this.file, fileSchema)).threads : []; }

  private async remember(entries: Entry[], entry: Entry): Promise<void> {
    await writeJsonAtomic(this.file, fileSchema.parse({ version: 1, threads: [...entries, entry] }));
  }

  /**
   * The person's Welcome: the one they have, or a new one. `again` opens another even when they have one (the
   * team's choice, `polycap thread welcome --again`). Returns its key and whether it was opened just now.
   */
  ensure(person: string, name: string | undefined, options: { again?: boolean } = {}): Promise<{ key: string; opened: boolean }> {
    return this.serial(async () => {
      if (!PERSON_ID.test(person)) throw new Error(`${person} is not a person id`);
      const entries = await this.entries();
      const had = entries.filter(e => e.person === person).at(-1);
      if (had && !options.again) return { key: had.key, opened: false };
      if (!options.again) {
        // Written to the thread store but not to welcome.json (a crash in between): adopt it, never open a second.
        const orphan = (await this.threads.list(AUTHOR, { project: this.settings.project }))
          .find(t => t.by.id === WELCOME_ID && t.members?.some(m => m.person === person) && !entries.some(e => e.key === t.key));
        if (orphan) {
          await this.remember(entries, { person, key: orphan.key, at: orphan.createdAt });
          return { key: orphan.key, opened: false };
        }
      }
      const thread = await this.threads.create(AUTHOR, {
        project: this.settings.project, title: TITLE, text: hello(name), launches: [launchFor(this.settings)], as: NAME, members: [person],
      });
      await this.remember(entries, { person, key: thread.key, at: thread.createdAt });
      return { key: thread.key, opened: true };
    });
  }

  /** After a bundle is built (the worker calls this): a Welcome's first recording by its person gets the follow-up. */
  onBuilt(link: UploadLink): Promise<boolean> { return this.reconcile(link.key); }

  /**
   * Posts the follow-up once the welcomed person's first recording in their Welcome is ready, unless it is
   * there already. A failed recording waits for the next one that builds; anyone else's recording is not theirs.
   */
  reconcile(key: string): Promise<boolean> {
    return this.serial(async () => {
      const entry = (await this.entries()).find(e => e.key === key);
      const thread = entry && await this.threads.get(key);
      if (!entry || !thread || followedUp(thread)) return false;
      const ready = new Set(thread.activity.flatMap(a => a.kind === 'recording.ready' && a.message ? [a.message] : []));
      const first = thread.messages.find(m => m.recording && ready.has(m.id) && personOf(m.by) === entry.person);
      if (!first?.recording) return false;
      const text = next(await this.heard(first.recording.uploadId), this.settings.url);
      await this.threads.post(AUTHOR, key, { text, as: NAME, deliveryId: NEXT });
      return true;
    });
  }

  /**
   * At start-up: every Welcome whose follow-up a crash or a restart got in the way of. Returns how many were
   * posted. A Welcome that cannot be read is logged, not a reason for the receiver not to start.
   */
  async sweep(log: (line: string) => void): Promise<number> {
    let posted = 0, entries: Entry[];
    try { entries = await this.entries(); } catch (error) { log(`welcome: ${this.file}: ${message(error)}`); return 0; }
    for (const { key } of entries) {
      try { if (await this.reconcile(key)) posted += 1; } catch (error) { log(`welcome: ${key}: ${message(error)}`); }
    }
    return posted;
  }

  /** What the bundle says, as far as it says it: nothing at all when the recording or its session has gone. */
  private async heard(uploadId: string): Promise<Heard | undefined> {
    const record = await this.uploads.get(uploadId);
    if (!record?.sessionId) return undefined;
    const dir = sessionDir(this.config, record.sessionId);
    try {
      const manifest = await loadSession(dir);
      const requestsFile = sessionPaths(dir).requests;
      // A missing or damaged requests.json leaves the requests out; the follow-up still says the rest.
      const requests = await exists(requestsFile) ? await readJson(requestsFile, requestsFileSchema).then(r => r.requests, () => []) : [];
      return { title: manifest.summary?.title, summary: manifest.summary?.text, durationMs: manifest.media.durationMs, requests };
    } catch { return undefined; }
  }
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const followedUp = (thread: Thread) => thread.messages.some(m => m.by.id === WELCOME_ID && m.deliveryId === NEXT);
