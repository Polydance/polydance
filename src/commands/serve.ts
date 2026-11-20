import { ensureLayout } from '../config.js';
import { privateDir } from '../fsx.js';
import { createReceiver } from '../server/http.js';
import { GoogleTokens, parseGoogleConfig, type GoogleEnv } from '../server/google.js';
import { GoogleTesters, isGoogleGrant } from '../server/google-testers.js';
import { MetaGraph, parseMetaConfig, type MetaEnv } from '../server/meta.js';
import { People } from '../server/people.js';
import { isTesterGrant, testerQuota, Testers } from '../server/testers.js';
import { ModelStore } from '../server/models.js';
import { PhotoStore } from '../server/photos.js';
import { parseNewMemberHistory, ThreadStore } from '../server/threads.js';
import { OwnProjects } from '../server/projects.js';
import { expired, isIssuedId, parseGrants, teamPeople } from '../server/tokens.js';
import { Agents } from '../server/agents.js';
import { UploadStore } from '../server/uploads.js';
import { parseWelcome, Welcome, WELCOME_ID } from '../server/welcome.js';
import { Invitations } from '../server/invitations.js';
import { parseMail, type MailEnv } from '../server/mail.js';
import { Join, parseJoin } from '../server/join.js';
import { Worker } from '../server/worker.js';
import { createTranscriber } from '../pipeline/transcribe.js';
import { UserError } from '../errors.js';
import { parseProjects, parseUsers } from '../threads.js';
import type { Cli } from './context.js';

export interface ServeOptions {
  host: string; port: number; tokens: string | undefined; projects?: string; users?: string;
  /** POLYCAP_REPORTS: the project reports from the headset's bug key open their threads in; none refuses reports. */
  reports?: string;
  /** POLYCAP_META_*: Meta sign-in for store testers, off when none are set. */
  meta?: MetaEnv;
  /** POLYCAP_GOOGLE_*: Google sign-in for Android XR testers, off when none are set. */
  google?: GoogleEnv;
  /** POLYCAP_PRIVACY_CONTACT, the email address the privacy notice gives. */
  privacyContact?: string;
  /** POLYCAP_WELCOME: the project a newcomer's Welcome thread opens in and the page it opens (welcome.ts); off when unset. */
  welcome?: string;
  /** POLYCAP_MAIL, POLYCAP_AHASEND_*, POLYCAP_PUBLIC_URL: email for invitations and confirmations (mail.ts); off when unset. */
  mail?: MailEnv;
  /** POLYCAP_JOIN: the homepage's form asking to join, emailed to the team (join.ts); off when unset, and needs POLYCAP_MAIL. */
  join?: string;
  /** POLYCAP_NEW_MEMBER_HISTORY: whether people added to a thread from now on see what came before, unless the team chooses; hidden unless `visible`. */
  newMemberHistory?: string;
}

/** How far ahead the start-up line warns of a token's expiry. */
const EXPIRY_WARNING_MS = 14 * 24 * 3600_000;

/** Refresh app entitlement hourly; this does not prove current release-channel membership. */
const TESTER_CHECK_MS = 3600_000;
const SWEEP_MS = 3600_000;

/**
 * Runs the hosted receiver until the process is stopped: the HTTP API plus one worker that turns
 * verified uploads into bundles. Tokens come from POLYCAP_SERVER_TOKENS and projects (which turn threads
 * on) from POLYCAP_PROJECTS; both are checked at start-up, and a token naming an unknown project is an error.
 * POLYCAP_REPORTS names the project reports from the headset's bug key go to, seen only by the team.
 * With POLYCAP_META_* set, store testers sign in with their Meta account and get tokens of their own;
 * with POLYCAP_GOOGLE_* set, Android XR testers do the same with their Google account. Testers, and tokens
 * marked `"threads": "member"`, see only the threads their person is a member of (tokens.ts). With threads on,
 * anyone with a device connects an agent of their own by a code (agents.ts), kept in agents.json.
 */
export async function serve(cli: Cli, options: ServeOptions): Promise<{ close: () => Promise<void>; port: number; testers?: Testers }> {
  const grants = parseGrants(options.tokens);
  let projects, users;
  try { projects = parseProjects(options.projects); users = parseUsers(options.users); } catch (error) { throw new UserError((error as Error).message); }
  for (const grant of grants) {
    const unknown = (grant.projects ?? []).filter(key => !projects.some(p => p.key === key));
    if (unknown.length) throw new UserError(`POLYCAP_SERVER_TOKENS: ${grant.id} names project(s) ${unknown.join(', ')}, which POLYCAP_PROJECTS does not have`);
    if (grant.user && !users.some(u => u.id === grant.user)) throw new UserError(`POLYCAP_SERVER_TOKENS: ${grant.id} names user ${grant.user}, which POLYCAP_USERS does not have`);
    if (isTesterGrant(grant)) throw new UserError(`POLYCAP_SERVER_TOKENS: ${grant.id}: ids starting meta- belong to testers who sign in with Meta`);
    if (isGoogleGrant(grant)) throw new UserError(`POLYCAP_SERVER_TOKENS: ${grant.id}: ids starting google- belong to testers who sign in with Google`);
    if (grant.id === WELCOME_ID) throw new UserError(`POLYCAP_SERVER_TOKENS: the id ${WELCOME_ID} is the receiver's own, for the Welcome thread`);
    if (isIssuedId(grant.id)) throw new UserError(`POLYCAP_SERVER_TOKENS: ${grant.id}: ids starting paired- belong to agents people connect with a code from their headset`);
  }
  if (users.some(u => u.id.startsWith('meta-'))) throw new UserError('POLYCAP_USERS: ids starting meta- belong to testers who sign in with Meta');
  if (users.some(u => u.id.startsWith('google-'))) throw new UserError('POLYCAP_USERS: ids starting google- belong to testers who sign in with Google');
  if (users.some(u => u.id === WELCOME_ID)) throw new UserError(`POLYCAP_USERS: the id ${WELCOME_ID} is the receiver's own, for the Welcome thread`);
  let welcomeSettings;
  try { welcomeSettings = parseWelcome(options.welcome, projects); } catch (error) { throw new UserError((error as Error).message); }
  let mail;
  try { mail = parseMail(options.mail ?? {}, cli.config.root); } catch (error) { throw new UserError((error as Error).message); }
  let joinSettings;
  try { joinSettings = parseJoin(options.join); } catch (error) { throw new UserError((error as Error).message); }
  if (joinSettings && !mail) throw new UserError('POLYCAP_JOIN needs POLYCAP_MAIL: each request is emailed to the team');
  const reports = options.reports?.trim() || undefined;
  if (reports && !projects.some(p => p.key === reports)) throw new UserError(`POLYCAP_REPORTS is ${reports}, which POLYCAP_PROJECTS does not have`);
  const meta = parseMetaConfig(options.meta ?? {});
  if (meta) {
    const unknown = meta.testers.projects.filter(key => !projects.some(p => p.key === key));
    if (unknown.length) throw new UserError(`POLYCAP_META_TESTERS names project(s) ${unknown.join(', ')}, which POLYCAP_PROJECTS does not have`);
    for (const [metaUser, user] of Object.entries(meta.testers.people)) {
      if (!users.some(u => u.id === user)) throw new UserError(`POLYCAP_META_TESTERS: Meta user ${metaUser} is mapped to ${user}, which POLYCAP_USERS does not have`);
    }
    const aliases = new Set<string>();
    const team = teamPeople(grants);
    for (const [metaUser, account] of Object.entries(meta.testers.accounts)) {
      const fail = (message: string): never => { throw new UserError(`POLYCAP_META_TESTERS.accounts.${metaUser}: ${message}`); };
      if (account.user.startsWith('meta-')) fail('reserved meta- user id');
      if (!users.some(u => u.id === account.user)) fail(`user ${account.user}, which POLYCAP_USERS does not have`);
      const unknown = account.projects.filter(key => !projects.some(p => p.key === key));
      if (unknown.length) fail(`project(s) ${unknown.join(', ')}, which POLYCAP_PROJECTS does not have`);
      const person = meta.testers.people[metaUser];
      if (person && person !== account.user) fail('user conflicts with people mapping');
      for (const id of account.legacyGrantIds) {
        if (isTesterGrant({ id })) fail(`legacy grant ${id} uses reserved meta- id`);
        if (aliases.has(id)) fail(`legacy grant ${id} is linked more than once`);
        aliases.add(id);
        const legacy = grants.find(g => g.id === id) ?? fail(`legacy grant ${id} does not exist in POLYCAP_SERVER_TOKENS`);
        if (!legacy.scopes.includes('upload') || legacy.scopes.some(s => s === 'read' || s === 'post')) fail(`legacy grant ${id} must be upload-only`);
        if (legacy.user !== account.user) fail(`legacy grant ${id} user must equal ${account.user}`);
        // An unscoped legacy grant can have recordings in any configured project.
        const missing = (legacy.projects ?? projects.map(p => p.key)).filter(key => !account.projects.includes(key));
        if (missing.length) fail(`projects must cover legacy grant ${id}: missing ${missing.join(', ')}`);
        // Configure every mapped legacy credential before enrollment, even for blocked/revoked Meta
        // accounts. Blocking Meta does NOT revoke legacy tokens: the operator must remove them separately.
        // Their quota stays shared; no reciprocal read/delete aliases are granted here.
        Object.assign(legacy, testerQuota(meta, metaUser));
        // A legacy headset token reaches what its person's Meta sign-in does: only their threads, unless they are the team's.
        if (!team.has(account.user)) legacy.threads = 'member';
      }
    }
  }
  const google = parseGoogleConfig(options.google ?? {});
  if (google) {
    const unknown = google.testers.projects.filter(key => !projects.some(p => p.key === key));
    if (unknown.length) throw new UserError(`POLYCAP_GOOGLE_TESTERS names project(s) ${unknown.join(', ')}, which POLYCAP_PROJECTS does not have`);
    for (const [email, user] of Object.entries(google.testers.people)) {
      if (!users.some(u => u.id === user)) throw new UserError(`POLYCAP_GOOGLE_TESTERS: ${email} is mapped to ${user}, which POLYCAP_USERS does not have`);
      if (!google.testers.invited.includes(email)) throw new UserError(`POLYCAP_GOOGLE_TESTERS: ${email} is mapped to ${user} but not invited`);
    }
  }
  let history;
  try { history = parseNewMemberHistory(options.newMemberHistory); } catch (error) { throw new UserError((error as Error).message); }
  const contact = options.privacyContact?.trim() || undefined;
  if (contact && !/^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(contact)) throw new UserError('POLYCAP_PRIVACY_CONTACT is an email address');
  await ensureLayout(cli.config);
  await privateDir(cli.config.uploads);
  const store = new UploadStore(cli.config.uploads);
  const models = new ModelStore(cli.config.threadModels, cli.config.modelMaxBytes, cli.config.modelsTotalBytes);
  // Beside testers.json; the same live list of people, so a tester signed in a moment ago has a name.
  const people = new People(cli.config.root, users);
  const photos = new PhotoStore(cli.config.threadPhotos, cli.config.photoMaxBytes, cli.config.photosTotalBytes);
  // People's own projects (2026-11-13), beside people.json: a damaged file, or a key the team's projects also have, stops the receiver.
  let threads: ThreadStore;
  try { threads = new ThreadStore(cli.config.threadsDir, projects, users, reports, models, people, photos, history, await OwnProjects.load(cli.config.root)); } catch (error) { throw new UserError((error as Error).message); }
  const worker = new Worker(cli.config, store, cli.print, threads, grants);
  // Beside people.json; the worker tells it when a bundle is built, for the Welcome's follow-up.
  const welcome = welcomeSettings && new Welcome(cli.config.root, welcomeSettings, threads, store, cli.config);
  if (welcome) worker.onBuilt = link => welcome.onBuilt(link);
  // Beside people.json; anything queued and never tried before a restart goes out now.
  const invitations = mail && new Invitations(cli.config.root, mail.mailer, mail.publicUrl, cli.print);
  invitations?.kick();
  const joining = joinSettings && mail && new Join(cli.config.root, joinSettings, mail.mailer, cli.print);
  let testers: Testers | undefined;
  if (meta) {
    testers = new Testers(cli.config.root, meta, new MetaGraph(meta), grants, users, cli.print);
    await testers.load();
  }
  let googleTesters: GoogleTesters | undefined;
  if (google) {
    googleTesters = new GoogleTesters(cli.config.root, google, new GoogleTokens(google), grants, users, people, cli.print);
    await googleTesters.load();
  }
  // Agents people connected themselves (2026-11-20), beside testers.json: a damaged file stops the receiver.
  // After the sign-ins, though the order does not matter: each agent is checked against its person's own tokens on every request.
  let agents: Agents | undefined;
  if (projects.length) {
    agents = new Agents(cli.config.root, grants, cli.print);
    try { await agents.load(); } catch (error) { throw new UserError((error as Error).message); }
  }
  // A follow-up a crash or restart got in the way of goes out before anyone can sign in or upload.
  const followed = await welcome?.sweep(cli.print);
  if (followed) cli.print(`posted ${followed} Welcome follow-up(s) left from the last run`);
  const server = createReceiver({ config: cli.config, grants, store, worker, threads, people, log: cli.print, testers, googleTesters, agents, privacyContact: contact, welcome, invitations, join: joining });
  await new Promise<void>((ready, fail) => { server.once('error', fail); server.listen(options.port, options.host, ready); });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  cli.print(`polycap receiver on http://${options.host}:${port} · ${grants.length} token(s)${testers ? ` · Meta sign-in for app ${meta!.appId}, ${testers.active.length} tester(s)` : ''}${googleTesters ? ` · Google sign-in, ${googleTesters.active.length} tester(s)` : ''}${agents ? ` · ${agents.connected} connected agent(s)` : ''} · transcriber ${createTranscriber(cli.config).describe()} · summary ${cli.config.summarizer === 'claude' ? cli.config.summaryModel : 'none'} · threads ${projects.length ? projects.map(p => p.key).join(', ') : 'off'}${threads.own?.list().length ? ` and ${threads.own.list().length} people's own` : ''} · reports ${reports ?? 'off'} · welcome ${welcomeSettings?.project ?? 'off'} · new members see ${history === 'hidden' ? 'from when they are added' : 'all history'} unless the team chooses · email ${invitations ? invitations.describe() : 'off'} · join ${joining ? joining.describe() : 'off'} · library ${cli.config.root}`);
  // Tokens that have expired, or will within a fortnight (2026-11-12): said at every start, so a deploy is a reminder.
  const now = Date.now();
  // Only the tokens set by hand: an agent someone connected is theirs to connect again (agents.ts).
  const lapsed = grants.filter(g => !g.issued && expired(g, now)).map(g => g.id);
  const ending = grants.filter(g => !g.issued && g.expiresAt && !expired(g, now) && Date.parse(g.expiresAt) - now < EXPIRY_WARNING_MS).map(g => `${g.id} (${g.expiresAt!.slice(0, 10)})`);
  if (lapsed.length) cli.print(`expired token(s), refused until replaced: ${lapsed.join(', ')}`);
  if (ending.length) cli.print(`token(s) expiring within 14 days: ${ending.join(', ')}`);
  const recovered = await worker.recover();
  if (recovered) cli.print(`resuming ${recovered} upload(s) left from the last run`);
  // Revalidate persisted accounts at startup without holding up listening/recovery on Meta outages.
  // MetaGraph bounds each call; request-time freshness still fails closed after 24h.
  const refreshTesters = () => { void testers?.check().catch(() => cli.print('tester check failed')); };
  refreshTesters();
  const checking = testers && setInterval(refreshTesters, TESTER_CHECK_MS);
  checking?.unref();
  // Videos whose kept days ran out go within the hour even when nothing new arrives (storage.ts, expireVideos).
  const sweeping = setInterval(() => worker.sweep(), SWEEP_MS);
  sweeping.unref();
  return {
    port, testers,
    close: async () => { if (checking) clearInterval(checking); clearInterval(sweeping); await new Promise<void>(done => server.close(() => done())); await worker.idle(); await invitations?.idle(); await agents?.idle(); },
  };
}
