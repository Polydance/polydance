/**
 * The polydance.net homepage (site/, Robin's pick of 2026-11-10): site/ holds only what is published, its pages
 * fetch nothing from anywhere but the site (Google Analytics only once a visitor allows it, Robin, 2026-11-12) and
 * link only where private/docs/SITE.md says, Vercel sends the same policy as the pages carry, and the wood is the headset app's, from the same java.util.Random the Mac's
 * RetroLookTests check. Its colours are checked with the others in design.test.ts.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { joinFormSchema, joinSettingsSchema, workDigest, zeroBits } from '../src/server/join.js';

const ROOT = join(import.meta.dirname, '..');
const SITE = join(ROOT, 'site');
const PAGES = ['index.html', '404.html'];
const POLICY = "default-src 'none'; img-src 'self' data: https://*.google-analytics.com https://*.googletagmanager.com; style-src 'self'; script-src 'self' https://*.googletagmanager.com; connect-src https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com; base-uri 'none'; form-action https://capture.polydance.net";
const read = (file: string) => readFile(join(SITE, file), 'utf8');

interface JavaRandomLike { nextInt(bound?: number): number; nextFloat(): number }
interface Cabinet {
  JavaRandom: new (seed: number) => JavaRandomLike;
  woodBoards(boards: number): { top: number; tone: string; shift: number; grain: { alpha: number; width: number }[] }[];
}
/** site/cabinet.js is plain browser JavaScript; it does nothing on import without a document. */
const cabinet = async () => (await import(pathToFileURL(join(SITE, 'cabinet.js')).href)) as Cabinet;
interface JoinScript { solve(prefix: string, bits: number): Promise<string>; workPrefix(stamp: number, email: string): string }
const joinScript = async () => (await import(pathToFileURL(join(SITE, 'join.js')).href)) as JoinScript;
interface StoryAt { phase: string; second: number; printed: number }
interface Story { LOOP: number; storyAt(t: number): StoryAt; clock(s: number): string }
const storyScript = async () => (await import(pathToFileURL(join(SITE, 'story.js')).href)) as Story;
interface Analytics { MEASUREMENT_ID: string; KEY: string; TAG: string; decide(stored: string | null): string; runConsent(win: object, doc: object): void }
const analyticsScript = async () => (await import(pathToFileURL(join(SITE, 'analytics.js')).href)) as Analytics;

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(path)));
    else out.push(relative(SITE, path));
  }
  return out;
}

const VercelConfig = z.object({
  headers: z.array(z.object({ source: z.string(), headers: z.array(z.object({ key: z.string(), value: z.string() })) })),
}).loose();

describe('the polydance.net homepage', () => {
  it('holds only what is published: the pages, their style and script, the Vercel config and images', async () => {
    const all = (await files(SITE)).filter((f) => !f.startsWith('.vercel/') && f !== '.DS_Store' && !f.endsWith('/.DS_Store')).sort();
    for (const file of all) expect(file, `${file} would be served on polydance.net; notes go in private/docs/SITE.md`).toMatch(/^(?:index\.html|404\.html|site\.css|cabinet\.js|story\.js|join\.js|analytics\.js|vercel\.json|assets\/[a-z0-9-]+\.png)$/);
    expect(all).toEqual(expect.arrayContaining(['index.html', '404.html', 'site.css', 'cabinet.js', 'story.js', 'join.js', 'analytics.js', 'vercel.json', 'assets/polydance-mark.png']));
  });

  it.each(PAGES)('%s fetches nothing from another site', async (file) => {
    const html = await read(file);
    const fetched = [...html.matchAll(/<(?:img|script|image|link)\b[^>]*?\s(?:src|href)="([^"]+)"/g)]
      .filter((m) => !/rel="canonical"/.test(m[0]))
      .map((m) => m[1]!);
    expect(fetched.length).toBeGreaterThan(2);
    for (const url of fetched) expect(url, `${url} is fetched from elsewhere`).toMatch(/^\/?(?:[a-z0-9-]+\/)*[a-z0-9-]+\.[a-z]+$/);
    // 404.html is served at any path, so it fetches by absolute paths.
    if (file === '404.html') for (const url of fetched) expect(url, `${url} in 404.html must start with /`).toMatch(/^\//);
    // The page says so to the browser too, so nothing added later can quietly load from elsewhere.
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${POLICY}">`);
    expect(html, 'an inline style would be refused by the policy').not.toMatch(/\sstyle="/);
    expect(html, 'an inline script would be refused by the policy').not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
  });

  it.each(PAGES)('%s links only to itself, the receiver\'s getting-started and privacy pages, and hello@polydance.net', async (file) => {
    const html = await read(file);
    const links = [...html.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)].map((m) => m[1]!);
    const allowed = /^(?:#[a-z]+|\/|https:\/\/capture\.polydance\.net\/(?:start|privacy)|mailto:hello@polydance\.net(?:\?subject=[A-Za-z%0-9]+)?)$/;
    for (const link of links) expect(link, `${link}: add it to private/docs/SITE.md and here, or link elsewhere`).toMatch(allowed);
    for (const id of links.filter((l) => l.startsWith('#')).map((l) => l.slice(1))) expect(html, `#${id} has no target`).toContain(`id="${id}"`);
  });

  it('has Vercel send the pages\' policy as a header, with framing refused, which a meta tag cannot do', async () => {
    const config = VercelConfig.parse(JSON.parse(await read('vercel.json')));
    const every = config.headers.find((h) => h.source === '/(.*)');
    expect(every, 'no headers for every path').toBeDefined();
    const header = (key: string) => every!.headers.find((h) => h.key === key)?.value;
    expect(header('Content-Security-Policy')).toBe(`${POLICY}; frame-ancestors 'none'`);
    expect(header('X-Content-Type-Options')).toBe('nosniff');
    expect(header('Referrer-Policy')).toBe('no-referrer');
  });

  it('asks to join through a form that posts only to the receiver\'s /join, with the fields join.ts takes', async () => {
    const html = await read('index.html');
    const forms = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)];
    expect(forms).toHaveLength(1);
    const [, attributes, inner] = forms[0]!;
    expect(attributes).toContain('method="post"');
    expect(attributes).toContain('action="https://capture.polydance.net/join"');
    // The page asks for the work the receiver checks by default.
    expect(attributes).toContain(`data-bits="${joinSettingsSchema.parse({ notify: 'a@b.co', site: 'https://x.example' }).bits}"`);
    const names = [...inner.matchAll(/\sname="([^"]+)"/g)].map(m => m[1]).sort();
    expect(names).toEqual(Object.keys(joinFormSchema.shape).sort());
    expect(html, 'no email address on the page: the form replaced it').not.toMatch(/mailto:|hello@polydance\.net/);
  });

  it('solves the proof of work in the browser exactly as the receiver checks it', async () => {
    const { solve, workPrefix } = await joinScript();
    const stamp = 1_794_400_000_000;
    for (const email of ['Ana@Example.com ', 'b@example.org']) {
      const nonce = await solve(workPrefix(stamp, email), 10);
      expect(joinFormSchema.shape.nonce.safeParse(nonce).success).toBe(true);
      expect(zeroBits(workDigest(stamp, email, nonce))).toBeGreaterThanOrEqual(10);
    }
  });

  it('plays How it works from recording to printed, and shows it printed without its script', async () => {
    const { LOOP, storyAt, clock } = await storyScript();
    const phases = Array.from({ length: Math.ceil(LOOP * 10) }, (_, i) => storyAt(i / 10).phase);
    expect([...new Set(phases)]).toEqual(['recording', 'processing', 'printing', 'ready', 'torn']);
    expect(storyAt(0)).toMatchObject({ phase: 'recording', second: 0, printed: 0 });
    expect(storyAt(LOOP - 1.5)).toMatchObject({ phase: 'ready', printed: 1 });
    expect(storyAt(LOOP + 1).phase).toBe('recording');
    // The markup is the story's end: the counter stopped, every line said, the storyboard fed out of the slot.
    const html = await read('index.html');
    expect(html).toContain(`<text id="story-counter" x="100" y="327" font-family="'Courier New', ui-monospace, monospace" font-weight="700" font-size="22" fill="#ECE8DE" text-anchor="middle">${clock(storyAt(LOOP - 1.5).second)}</text>`);
    const said = [...html.matchAll(/<li class="bubble" data-at="(\d+)">/g)].map((m) => Number(m[1]));
    expect(said.length).toBe(4);
    expect(said).toEqual([...said].sort((a, b) => a - b));
    expect(Math.max(...said)).toBeLessThan(storyAt(LOOP - 1.5).second);
    const paper = html.match(/<g id="story-paper" data-height="(\d+)" data-slot="(\d+)" transform="translate\(0 (-?\d+)\)">/);
    expect(paper, 'the printout is not in the page').not.toBeNull();
    expect(Number(paper![3])).toBe(Number(paper![2]) - Number(paper![1]));
  });

  it('counts a visit with Google Analytics only once the visitor allows it, and stops when they say no', async () => {
    const { MEASUREMENT_ID, KEY, TAG, decide, runConsent } = await analyticsScript();
    expect([decide(null), decide('yes'), decide('no'), decide('maybe')]).toEqual(['ask', 'count', 'none', 'ask']);
    expect(MEASUREMENT_ID).toMatch(/^G-[A-Z0-9]{10}$/);
    // The page: the bar and the footer's button hidden until the script runs, Allow and No thanks the same key.
    const html = await read('index.html');
    expect(html).toContain('<aside id="consent" class="consent plate" aria-label="Cookies" hidden>');
    expect(html).toContain('<button type="button" id="consent-again" class="link" hidden>Cookies</button>');
    const keys = [...html.matchAll(/<button type="button" class="([^"]+)" data-consent="(yes|no)">/g)];
    expect(keys.map((k) => k[2])).toEqual(['yes', 'no']);
    expect(keys[0]![1]).toBe(keys[1]![1]);

    // A stand-in page and browser, as much of them as analytics.js touches.
    const page = (stored: string | null) => {
      const store = new Map<string, string>(stored === null ? [] : [[KEY, stored]]);
      const scripts: string[] = [], cookies: string[] = [];
      let click: (event: object) => void = () => {}, again: () => void = () => {};
      const bar = { hidden: true, addEventListener: (_: string, fn: typeof click) => { click = fn; }, querySelector: () => ({ focus() {} }) };
      const button = { hidden: true, addEventListener: (_: string, fn: typeof again) => { again = fn; } };
      const doc = {
        getElementById: (id: string) => (id === 'consent' ? bar : id === 'consent-again' ? button : null),
        createElement: () => ({ async: false, src: '' }),
        head: { append: (script: { src: string }) => scripts.push(script.src) },
        get cookie() { return '_ga=GA1.1.42; _ga_E4566ST899=GS1.1.42; other=1'; },
        set cookie(value: string) { cookies.push(value); },
      };
      const win: Record<string, unknown> = {
        location: { hostname: 'polydance.net' },
        localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) },
      };
      runConsent(win, doc);
      const answer = (consent: string) => click({ target: { closest: () => ({ dataset: { consent } }) } });
      return { win, bar, button, scripts, cookies, store, answer, again: () => again() };
    };

    // A first visit asks, and fetches nothing from Google until Allow.
    const first = page(null);
    expect([first.bar.hidden, first.button.hidden, first.scripts]).toEqual([false, false, []]);
    first.answer('yes');
    expect([first.bar.hidden, first.scripts, first.store.get(KEY)]).toEqual([true, [TAG], 'yes']);
    expect((first.win.dataLayer as ArrayLike<unknown>[]).map((call) => Array.from(call))).toContainEqual(['config', MEASUREMENT_ID]);
    // Cookies asks again; No thanks stops the tag and removes Google's cookies, and only those.
    first.again();
    expect(first.bar.hidden).toBe(false);
    first.answer('no');
    expect(first.win[`ga-disable-${MEASUREMENT_ID}`]).toBe(true);
    expect(first.store.get(KEY)).toBe('no');
    expect(first.cookies).toContain('_ga=; max-age=0; path=/; domain=.polydance.net');
    expect(first.cookies).toContain('_ga_E4566ST899=; max-age=0; path=/; domain=.polydance.net');
    expect(first.cookies.filter((c) => !/^_ga(?:_[A-Z0-9]+)?=; max-age=0; path=\//.test(c))).toEqual([]);
    expect(first.scripts).toEqual([TAG]);
    // A visitor who said yes is counted without asking; one who said no is left alone.
    const yes = page('yes');
    expect([yes.bar.hidden, yes.scripts]).toEqual([true, [TAG]]);
    const no = page('no');
    expect([no.bar.hidden, no.scripts]).toEqual([true, []]);
  });

  it('draws the wood with java.util.Random, as the headset and the Mac do', async () => {
    const { JavaRandom, woodBoards } = await cabinet();
    // The values RetroLookTests.swift checks: new Random(42).nextInt() and nextFloat(), as every JVM gives them.
    expect(new JavaRandom(42).nextInt()).toBe(-1_170_105_035);
    expect(new JavaRandom(42).nextFloat()).toBeCloseTo(0.7275637, 7);
    const c = new JavaRandom(1966);
    for (let i = 0; i < 1000; i++) {
      const nine = c.nextInt(9), sixtyFour = c.nextInt(64), unit = c.nextFloat();
      expect(nine >= 0 && nine < 9 && sixtyFour >= 0 && sixtyFour < 64 && unit >= 0 && unit < 1).toBe(true);
    }
    const boards = woodBoards(10);
    expect(boards.map((b) => b.top)).toEqual([0, 150, 300, 450, 600, 750, 900, 1050, 1200, 1350]);
    expect(boards.map((b) => b.tone)).toEqual(Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? '#E0C294' : '#D2B07E')));
    for (const b of boards) {
      expect(b.shift).toBeGreaterThanOrEqual(-4); expect(b.shift).toBeLessThanOrEqual(4);
      expect(b.grain.length).toBeGreaterThanOrEqual(10); expect(b.grain.length).toBeLessThanOrEqual(15);
      for (const g of b.grain) { expect(g.alpha).toBeGreaterThanOrEqual(26 / 255); expect(g.alpha).toBeLessThan(90 / 255); }
    }
  });
});
