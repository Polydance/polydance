/**
 * Agents people connect themselves (Robin, 2026-11-20; docs/THREADS.md "Connecting your own agent"). Someone
 * signed in on a headset asks for a one-time code there and types it into `polycap connect` on their computer,
 * which redeems it for a token of its own. Until this, an agent's token was a line Robin added to
 * POLYCAP_SERVER_TOKENS by hand, and could not be a signed-in tester's own person at all (serve.ts).
 *
 * An issued token is a grant the receiver makes: `paired-<8 hex>`, `read` and `post`, never `upload`, always
 * thread-scoped, with no team project, and its `user` the person of the device that asked. So it sees the
 * threads that person is in and the projects they own, the headset sees the threads it opens, and nobody's
 * person id changes. It counts only while that person still has a token of their own that counts (their sign-in,
 * or one the team made), so blocking a sign-in stops their agents too.
 *
 * agents.json beside testers.json (0600) holds each one's sha256, never the token. It is read at start-up, where
 * a damaged file is an error, and its grants are put in the receiver's live list in place, as a tester's are.
 * Codes live only in memory, as sha256: a restart voids them, and the person asks again. One writer at a time.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { z } from 'zod';
import { exists, readJson, writeJsonAtomic } from '../fsx.js';
import { agentLabelSchema, CODE_ALPHABET, codeSchema, normalCode, showCode } from '../pairing.js';
import { senderAddress } from './join.js';
import { PERSON_ID, personId } from './people.js';
import { HttpError, need, parse, readJsonBody, send, type ServerDeps } from './respond.js';
import { expired, ISSUED_ID, newToken, type Grant } from './tokens.js';

const MINUTE = 60_000, DAY = 24 * 3600_000;
export const AGENT_LIMITS = {
  /** Agents one person may have connected at once. */
  perPerson: 5,
  /** How long a code works, and a token. */
  codeMs: 10 * MINUTE, tokenDays: 90,
  /** An expired agent stays listed this long, so its 401 says it expired, not that it is unknown. */
  keepExpiredDays: 30,
  /** In any ten minutes: codes one person may ask for, and tries at redeeming one, per sender and in all. */
  windowMs: 10 * MINUTE, codesPerPerson: 6, triesPerSender: 10, triesInAll: 60,
};

const agentSchema = z.strictObject({
  id: z.string().regex(ISSUED_ID),
  /** Whose agent it is: the person of the device that asked for the code (people.ts personId). */
  person: z.string().regex(PERSON_ID),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  label: z.string().min(1).max(40),
  connectedAt: z.iso.datetime({ offset: true }),
  /** The device that showed the code: its grant id and what it calls itself, "Quest 3". */
  from: z.strictObject({ id: z.string().max(100), label: z.string().max(80).optional() }),
  expiresAt: z.iso.datetime({ offset: true }),
  /** The day it last made a request (UTC), written at most once a day. */
  lastUsedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
const fileSchema = z.strictObject({ version: z.literal(1), agents: z.array(agentSchema) });
type Agent = z.infer<typeof agentSchema>;

const redeemSchema = z.strictObject({ code: codeSchema, label: agentLabelSchema.optional() });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Attempts in a sliding window, for one key and for everyone; a refused attempt is not counted. */
class Limiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly windowMs: number, private readonly limits: { all: number; each: number }) {}
  allow(key: string, now: number): boolean {
    for (const [k, times] of this.hits) {
      const fresh = times.filter(t => now - t < this.windowMs);
      if (fresh.length) this.hits.set(k, fresh); else this.hits.delete(k);
    }
    const all = this.hits.get('*') ?? [], each = this.hits.get(key) ?? [];
    if (all.length >= this.limits.all || each.length >= this.limits.each) return false;
    this.hits.set('*', [...all, now]); this.hits.set(key, [...each, now]);
    return true;
  }
}

export interface AgentView { id: string; label: string; connectedAt: string; connectedFrom: string; expiresAt: string; lastUsedOn?: string; expired?: true }

export class Agents {
  private agents: Agent[] = [];
  /** Live codes by sha256: whose, and which device asked. */
  private readonly codes = new Map<string, { person: string; from: Agent['from']; expiresAt: number }>();
  private readonly added = new Set<Grant>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly asking = new Limiter(AGENT_LIMITS.windowMs, { all: 600, each: AGENT_LIMITS.codesPerPerson });
  private readonly trying = new Limiter(AGENT_LIMITS.windowMs, { all: AGENT_LIMITS.triesInAll, each: AGENT_LIMITS.triesPerSender });
  readonly file: string;

  constructor(
    dir: string,
    /** The receiver's live list, changed in place. */
    private readonly grants: Grant[],
    private readonly log: (line: string) => void,
    private readonly now: () => number = Date.now,
  ) { this.file = join(dir, 'agents.json'); }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Whatever is being written has been. */
  idle(): Promise<void> { return this.queue.then(() => undefined); }

  /** Fails closed: a file that does not parse, or names an agent twice, stops the receiver at start-up. */
  async load(): Promise<void> {
    this.agents = await exists(this.file) ? (await readJson(this.file, fileSchema)).agents : [];
    if (new Set(this.agents.map(a => a.id)).size !== this.agents.length) throw new Error(`${this.file} has an agent id twice`);
    this.apply();
  }

  /** How many are connected and not expired, for the start-up line. */
  get connected(): number { return this.agents.filter(a => !expired(a, this.now())).length; }

  private async save(): Promise<void> {
    // An expired one is forgotten once its 401 has had a month to say why.
    this.agents = this.agents.filter(a => this.now() - Date.parse(a.expiresAt) < AGENT_LIMITS.keepExpiredDays * DAY);
    await writeJsonAtomic(this.file, fileSchema.parse({ version: 1, agents: this.agents }));
    this.apply();
  }

  /** Puts every agent's grant in the receiver's list, replacing what was there before. */
  private apply(): void {
    for (let i = this.grants.length - 1; i >= 0; i--) if (this.added.has(this.grants[i])) this.grants.splice(i, 1);
    this.added.clear();
    for (const agent of this.agents) {
      // No team project at all (`projects: []`), START included: it opens threads only in a project its person owns.
      const grant: Grant = { id: agent.id, sha256: agent.sha256, scopes: ['read', 'post'], label: agent.label, user: agent.person, threads: 'member', projects: [], expiresAt: agent.expiresAt, issued: true };
      this.grants.push(grant); this.added.add(grant);
    }
  }

  private live(person: string): Agent[] { return this.agents.filter(a => a.person === person && !expired(a, this.now())); }

  private full(): HttpError {
    return new HttpError(403, `you have ${AGENT_LIMITS.perPerson} agents connected, which is as many as one person may; disconnect one first`, { reason: 'agent_limit' });
  }

  /** A device asks for a code for its person: one live at a time, shown once. */
  code(device: Grant): { code: string; expiresAt: string } {
    if (device.issued || !device.scopes.includes('upload')) throw new HttpError(403, 'a code comes from one of your own devices, such as the headset', { reason: 'not_device' });
    const person = personId(device), now = this.now();
    // Said first, and not counted: asking again cannot help until one is disconnected.
    if (this.live(person).length >= AGENT_LIMITS.perPerson) throw this.full();
    if (!this.asking.allow(person, now)) throw new HttpError(429, 'too many codes; try again in a few minutes', { reason: 'slow_down' });
    for (const [hash, held] of this.codes) if (held.person === person || held.expiresAt <= now) this.codes.delete(hash);
    const code = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    const expiresAt = now + AGENT_LIMITS.codeMs;
    this.codes.set(sha(code), { person, from: { id: device.id, ...(device.label ? { label: device.label } : {}) }, expiresAt });
    return { code: showCode(code), expiresAt: iso(expiresAt) };
  }

  /**
   * Redeems a code for a token, shown this once. A wrong, used or expired code is the same 404, so the route
   * never says which codes exist; every try counts against its sender and against everyone.
   */
  redeem(body: unknown, sender: string): Promise<{ token: string; grant: Grant }> {
    if (!this.trying.allow(sender, this.now())) return Promise.reject(new HttpError(429, 'too many tries; wait ten minutes and ask the headset for a new code', { reason: 'slow_down' }));
    return this.serial(async () => {
      const input = parse(redeemSchema, body);
      const hash = sha(normalCode(input.code)), held = this.codes.get(hash), now = this.now();
      const none = new HttpError(404, 'no such code: it may have been used or have run out; ask the headset for a new one', { reason: 'no_code' });
      if (!held || held.expiresAt <= now) { this.codes.delete(hash); throw none; }
      // Someone whose own tokens have all gone since they asked gets no agent.
      if (!this.grants.some(g => !g.issued && personId(g) === held.person)) { this.codes.delete(hash); throw none; }
      if (this.live(held.person).length >= AGENT_LIMITS.perPerson) throw this.full();
      this.codes.delete(hash);
      const { token, sha256 } = newToken();
      let id: string;
      do id = `paired-${randomBytes(4).toString('hex')}`; while (this.grants.some(g => g.id === id) || this.agents.some(a => a.id === id));
      const agent: Agent = {
        id, person: held.person, sha256, label: input.label ?? 'Computer', connectedAt: iso(now), from: held.from,
        expiresAt: iso(now + AGENT_LIMITS.tokenDays * DAY),
      };
      this.agents.push(agent);
      await this.save();
      this.log(`agent ${id} (${agent.label}) connected for ${agent.person} from ${held.from.label ?? held.from.id}; they have ${this.live(agent.person).length}`);
      return { token, grant: this.grants.find(g => g.id === id)! };
    });
  }

  /**
   * Checked on every request an issued token makes: it is still one of ours, and its person still has a token
   * of their own that `counts` (admitted and not expired, which http.ts knows).
   */
  authorized(grant: Grant, counts: (own: Grant) => boolean): boolean {
    return this.agents.some(a => a.id === grant.id && a.sha256 === grant.sha256)
      && this.grants.some(own => !own.issued && personId(own) === personId(grant) && counts(own));
  }

  /** Notes the day an agent was last used, written at most once a day. */
  used(grant: Grant): void {
    const agent = this.agents.find(a => a.id === grant.id), day = new Date(this.now()).toISOString().slice(0, 10);
    if (!agent || agent.lastUsedOn === day) return;
    agent.lastUsedOn = day;
    void this.serial(() => this.save()).catch(error => this.log(`agents.json not written: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** A person's agents, oldest first, for the device that lists them. */
  list(person: string): AgentView[] {
    return this.agents.filter(a => a.person === person).sort((a, b) => a.connectedAt.localeCompare(b.connectedAt)).map(a => ({
      id: a.id, label: a.label, connectedAt: a.connectedAt, connectedFrom: a.from.label ?? a.from.id, expiresAt: a.expiresAt,
      ...(a.lastUsedOn ? { lastUsedOn: a.lastUsedOn } : {}), ...(expired(a, this.now()) ? { expired: true as const } : {}),
    }));
  }

  /** Disconnects one of `by`'s person's agents: any of them from a device, only itself from an agent. False when it is not theirs. */
  disconnect(id: string, by: Grant): Promise<boolean> {
    return this.serial(async () => {
      const agent = this.agents.find(a => a.id === id && a.person === personId(by) && (!by.issued || a.id === by.id));
      if (!agent) return false;
      this.agents = this.agents.filter(a => a !== agent);
      await this.save();
      this.log(`agent ${agent.id} (${agent.label}) of ${agent.person} disconnected by ${by.id}`);
      return true;
    });
  }
}

const off = () => new HttpError(404, 'this receiver does not connect agents: threads are off', { reason: 'agents_off' });

/**
 * POST /v1/agents, with no token: `{ code, label? }` for a token. Handled before authentication, since the code
 * is the credential. True when the request was this route.
 */
export async function redeemRoute(req: IncomingMessage, res: ServerResponse, path: string, deps: ServerDeps): Promise<boolean> {
  if (req.method !== 'POST' || path !== '/v1/agents') return false;
  if (!deps.agents) throw off();
  const { token, grant } = await deps.agents.redeem(await readJsonBody(req), senderAddress(req));
  send(res, 201, { token, id: grant.id, label: grant.label, expiresAt: grant.expiresAt, person: { name: deps.people.person(grant).name } });
  return true;
}

/**
 *   POST   /v1/agents/codes   upload         a code for this device's person, to type into `polycap connect`
 *   GET    /v1/agents         upload         that person's agents
 *   DELETE /v1/agents/:id     upload, or the agent itself (`self`)   disconnects it
 */
export async function agentRoutes(req: IncomingMessage, res: ServerResponse, parts: string[], grant: Grant | undefined, deps: ServerDeps): Promise<boolean> {
  if (parts[1] !== 'agents') return false;
  const device = () => {
    const g = need(grant, 'upload');
    if (!deps.agents) throw off();
    return { g, agents: deps.agents };
  };
  if (req.method === 'POST' && parts.length === 3 && parts[2] === 'codes') {
    const { g, agents } = device();
    send(res, 201, { ...agents.code(g), agents: agents.list(personId(g)).filter(a => !a.expired).length, limit: AGENT_LIMITS.perPerson });
    return true;
  }
  if (req.method === 'GET' && parts.length === 2) {
    const { g, agents } = device();
    send(res, 200, { me: g.id, agents: agents.list(personId(g)), limit: AGENT_LIMITS.perPerson });
    return true;
  }
  if (req.method === 'DELETE' && parts.length === 3) {
    // An agent may disconnect itself, and nothing else; a device, any of its person's.
    const g = grant?.issued ? grant : need(grant, 'upload');
    if (!deps.agents) throw off();
    const id = parts[2] === 'self' && g.issued ? g.id : parts[2];
    if (!ISSUED_ID.test(id) || !await deps.agents.disconnect(id, g)) throw new HttpError(404, 'no such agent');
    send(res, 200, { id, disconnected: true });
    return true;
  }
  throw new HttpError(404, 'not found');
}
