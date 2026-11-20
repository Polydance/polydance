/**
 * People's own projects (Robin, 2026-11-13: projects belong to a person, not to everyone; docs/THREADS.md
 * "Projects of your own"). The team's projects stay in POLYCAP_PROJECTS; these are made with POST /v1/projects
 * and kept in projects.json beside people.json (0600). Read once at start-up, so a damaged file stops the
 * receiver rather than losing everyone's projects, and held in memory after: the receiver is this file's only
 * writer, and the thread store asks which projects a token sees on every request. One writer at a time.
 */
import { join } from 'node:path';
import { z } from 'zod';
import { exists, readJson, writeJsonAtomic } from '../fsx.js';
import { MAX_OWN_PROJECTS, ownProjectSchema, projectKeyFrom, type EditProject, type NewProject, type OwnProject } from '../threads.js';
import { ThreadError } from './threads.js';

const fileSchema = z.strictObject({ version: z.literal(1), projects: z.array(ownProjectSchema) });

export class OwnProjects {
  readonly file: string;
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(dir: string, private projects: OwnProject[]) { this.file = join(dir, 'projects.json'); }

  /** Fails closed: a file that does not parse, or has a key twice, is an error at start-up. */
  static async load(dir: string): Promise<OwnProjects> {
    const file = join(dir, 'projects.json');
    const projects = await exists(file) ? (await readJson(file, fileSchema)).projects : [];
    const keys = new Set(projects.map(p => p.key));
    if (keys.size !== projects.length) throw new Error(`${file} has a project key twice`);
    return new OwnProjects(dir, projects);
  }

  list(): readonly OwnProject[] { return this.projects; }
  get(key: string): OwnProject | undefined { return this.projects.find(p => p.key === key); }
  ownedBy(person: string): OwnProject[] { return this.projects.filter(p => p.owner === person); }

  /**
   * Makes `owner`'s project: the key asked for, else one from the name. `taken` says whether a key is
   * someone else's already (a team project's, or one with threads on disk); this store adds its own.
   */
  create(owner: string, input: NewProject, taken: (key: string) => boolean): Promise<OwnProject> {
    const run = this.chain.then(async () => {
      if (this.ownedBy(owner).length >= MAX_OWN_PROJECTS) throw new ThreadError(403, `you have ${MAX_OWN_PROJECTS} projects, which is as many as one person may make`, { reason: 'project_limit' });
      const used = (key: string) => taken(key) || this.projects.some(p => p.key === key);
      if (input.key && used(input.key)) throw new ThreadError(409, `${input.key} is taken; choose another key, or leave it out and one is made from the name`, { reason: 'key_taken' });
      const project: OwnProject = ownProjectSchema.parse({
        key: input.key ?? projectKeyFrom(input.name, used), name: input.name, hosts: input.hosts ?? [], packages: input.packages ?? [],
        owner, createdAt: new Date().toISOString(),
      });
      const next = [...this.projects, project];
      await writeJsonAtomic(this.file, fileSchema.parse({ version: 1, projects: next }));
      this.projects = next;
      return project;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Replaces a project's hosts, packages or both (2026-11-20), for its owner alone; undefined when `key` is not
   * a project of `owner`'s. Launches are checked when posted, so messages already sent keep theirs.
   */
  edit(owner: string, key: string, change: EditProject): Promise<OwnProject | undefined> {
    const run = this.chain.then(async () => {
      const current = this.projects.find(p => p.key === key && p.owner === owner);
      if (!current) return undefined;
      const project = ownProjectSchema.parse({ ...current, ...(change.hosts ? { hosts: change.hosts } : {}), ...(change.packages ? { packages: change.packages } : {}) });
      const next = this.projects.map(p => p === current ? project : p);
      await writeJsonAtomic(this.file, fileSchema.parse({ version: 1, projects: next }));
      this.projects = next;
      return project;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}
