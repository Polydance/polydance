/**
 * One look on every platform: design/tokens.json holds every colour Polydance paints with, and this reads
 * the headset app's palette (Retro.kt, and the avatar colours in InboxViews.kt), the one Swift palette the
 * Mac, the iPhone and the Vision Pro share (PolydanceShared's Palette.swift, docs/IPHONE.md I1), the Swift views of all three,
 * the receiver's pages (privacy.ts, start.ts) and the polydance.net homepage (site/), and fails when one of them
 * has a colour that is not a token, or a token's value differs. A new colour is added to the tokens first. The logo
 * is one file in the token's colour (design/logo.py), and its copies for the store art and the homepage match it;
 * every platform's app icon is the one design/icons.py drew from it, in the Mac dock icon's style.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { privacyHtml } from '../src/server/privacy.js';
import { startHtml } from '../src/server/start.js';

const ROOT = join(import.meta.dirname, '..');
const RETRO = join(ROOT, 'app/android/app/src/main/java/net/polydance/capture/Retro.kt');
const INBOX_VIEWS = join(ROOT, 'app/android/app/src/main/java/net/polydance/capture/InboxViews.kt');
const PALETTE = join(ROOT, 'mac/Sources/PolydanceShared/Palette.swift');
/** Every folder of Swift that draws: the shared look, the Mac's views, the iPhone's screens, the Vision Pro's panel. */
const SWIFT_VIEWS = ['mac/Sources/PolydanceShared', 'mac/Sources/PolydanceCapture/Views', 'ios/App/Sources', 'visionos/App/Sources'].map((dir) => join(ROOT, dir));

/** The .swift files in a folder and its subfolders, as paths relative to the repository. */
async function swiftFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await swiftFiles(path)));
    else if (entry.name.endsWith('.swift')) out.push(path);
  }
  return out;
}

const Hex = z.string().regex(/^#[0-9A-F]{6}$/, 'colours are #RRGGBB in capitals');
const Tokens = z.object({
  colors: z.record(z.string().regex(/^[a-z][a-zA-Z]*$/), Hex),
  avatars: z.array(Hex).min(1),
  wood: z.object({ seed: z.number().int(), boardHeight: z.number().positive() }).loose(),
  parts: z.record(z.string(), z.union([Hex, z.tuple([Hex, Hex]), z.string()])),
}).loose();

async function tokens() {
  return Tokens.parse(JSON.parse(await readFile(join(ROOT, 'design/tokens.json'), 'utf8')));
}

const hex = (r: number, g: number, b: number) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
/** PLATE_LIGHT → plateLight. */
const camel = (name: string) => name.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Retro's `val NAME = Color.rgb(r, g, b)` lines. */
export function kotlinColours(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of source.matchAll(/val ([A-Z_]+) = Color\.rgb\((\d+), (\d+), (\d+)\)/g)) out[camel(m[1]!)] = hex(+m[2]!, +m[3]!, +m[4]!);
  return out;
}

/** Palette.swift's `static let name = Color(hex: 0xRRGGBB)` lines. */
export function swiftColours(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of source.matchAll(/static let ([a-zA-Z]+) = Color\(hex: 0x([0-9A-Fa-f]{6})\)/g)) out[m[1]!] = '#' + m[2]!.toUpperCase();
  return out;
}

describe('one look on every platform', () => {
  it('reads the tokens', async () => {
    const t = await tokens();
    expect(Object.keys(t.colors).length).toBeGreaterThan(20);
    expect(t.wood.seed).toBe(1966);
  });

  it('the headset app paints only with token colours, at the tokens\' values', async () => {
    const t = await tokens();
    const kotlin = kotlinColours(await readFile(RETRO, 'utf8'));
    expect(Object.keys(kotlin).length).toBeGreaterThan(20);
    for (const [name, value] of Object.entries(kotlin)) {
      expect(t.colors[name], `Retro.kt's ${name} is not in design/tokens.json`).toBeDefined();
      expect(value, `Retro.kt's ${name}`).toBe(t.colors[name]);
    }
    // The avatar palette: Avatar.PALETTE in InboxViews.kt, in order, since a person's colour is chosen by index.
    const views = await readFile(INBOX_VIEWS, 'utf8');
    const line = views.match(/PALETTE = intArrayOf\(([^\n]+)\)/)?.[1];
    expect(line, 'Avatar.PALETTE not found in InboxViews.kt').toBeDefined();
    const avatars = [...line!.matchAll(/Color\.rgb\((\d+), (\d+), (\d+)\)/g)].map((m) => hex(+m[1]!, +m[2]!, +m[3]!));
    expect(avatars).toEqual(t.avatars);
  });

  it('the Swift palette the Mac and the iPhone share has every token, at its value, and nothing else', async () => {
    const t = await tokens();
    const source = await readFile(PALETTE, 'utf8');
    expect(swiftColours(source)).toEqual(t.colors);
    const avatars = source.match(/static let avatars: \[Color\] = \[([^\]]+)\]/)?.[1];
    expect(avatars, 'Palette.avatars not found').toBeDefined();
    expect([...avatars!.matchAll(/0x([0-9A-Fa-f]{6})/g)].map((m) => '#' + m[1]!.toUpperCase())).toEqual(t.avatars);
  });

  it('every colour the Swift views paint with is a token, on the Mac, the iPhone and the Vision Pro', async () => {
    const t = await tokens();
    const values = new Set([...Object.values(t.colors), ...t.avatars,
      ...Object.entries(t.parts).filter(([k]) => k !== 'about').flatMap(([, v]) => (Array.isArray(v) ? v : [v]))]);
    const files = (await Promise.all(SWIFT_VIEWS.map(swiftFiles))).flat();
    expect(files.some((f) => f.includes('/ios/App/Sources/')), 'no iPhone screens found').toBe(true);
    expect(files.some((f) => f.includes('/visionos/App/Sources/')), 'no Vision Pro views found').toBe(true);
    let seen = 0;
    for (const path of files) {
      const file = path.slice(ROOT.length + 1);
      const source = await readFile(path, 'utf8');
      for (const m of source.matchAll(/Color\(hex: 0x([0-9A-Fa-f]{6})\)/g)) {
        seen += 1;
        expect(values.has('#' + m[1]!.toUpperCase()), `${file}: 0x${m[1]} is not in design/tokens.json`).toBe(true);
      }
      expect(source, `${file} writes a colour as numbers; use a token`)
        .not.toMatch(/Color\((\.sRGB, )?red: *[0-9.]|NSColor\(srgbRed: *[0-9.]|UIColor\(red: *[0-9.]/);
      // One palette: only PolydanceShared's Palette.swift says what the tokens are.
      if (path !== PALETTE) expect(source, `${file} declares a palette of its own; use PolydanceShared's Palette`).not.toMatch(/enum Palette\b/);
    }
    expect(seen).toBeGreaterThan(40);
  });

  it.each([['privacy.ts', privacyHtml(undefined)], ['start.ts', startHtml(undefined)]])('the receiver\'s page in %s uses token colours', async (file, html) => {
    const t = await tokens();
    const values = new Set(Object.values(t.colors));
    const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
    const used = [...style.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0].toUpperCase());
    expect(used.length).toBeGreaterThan(4);
    for (const colour of used) expect(values.has(colour), `${colour} in ${file} is not a token`).toBe(true);
  });

  it('the homepage in site/ paints only with token colours', async () => {
    const t = await tokens();
    const values = new Set([...Object.values(t.colors), ...t.avatars,
      ...Object.entries(t.parts).filter(([k]) => k !== 'about').flatMap(([, v]) => (Array.isArray(v) ? v : [v]))]);
    let seen = 0;
    for (const file of ['site/index.html', 'site/404.html', 'site/site.css', 'site/cabinet.js', 'site/story.js']) {
      const source = await readFile(join(ROOT, file), 'utf8');
      for (const m of source.matchAll(/#[0-9a-fA-F]{6}\b/g)) {
        seen += 1;
        expect(values.has(m[0].toUpperCase()), `${m[0]} in ${file} is not in design/tokens.json`).toBe(true);
      }
    }
    expect(seen).toBeGreaterThan(40);
  });

  it('the ballerina is one file: the store art and the homepage carry the mark design/logo.py drew', async () => {
    const t = await tokens();
    expect(t.colors.logo, 'design/tokens.json has no colors.logo for design/logo.py').toBeDefined();
    const sha = async (path: string) => createHash('sha256').update(await readFile(join(ROOT, path))).digest('hex');
    const mark = await sha('app/android/app/src/main/res/drawable-nodpi/polydance_mark.png');
    for (const copy of ['store-assets/polydance/source/polydance-mark.png', 'site/assets/polydance-mark.png']) {
      expect(await sha(copy), `${copy} differs from the mark; run python3 -I design/logo.py`).toBe(mark);
    }
  });

  it("every platform's app icon is the Mac dock icon's style, as design/icons.py drew it from the mark", async () => {
    const sha = async (path: string) => createHash('sha256').update(await readFile(join(ROOT, path))).digest('hex');
    const read = (path: string) => readFile(join(ROOT, path), 'utf8');
    const Sha = z.string().regex(/^[0-9a-f]{64}$/);
    const record = z
      .object({ drawnBy: z.literal('design/icons.py'), markSha256: Sha, files: z.record(z.string(), Sha) })
      .parse(JSON.parse(await read('design/icons.json')));
    const redraw = 'run python3 -I design/icons.py';
    expect(record.markSha256, `the icons were drawn from another mark; ${redraw}`).toBe(await sha('app/android/app/src/main/res/drawable-nodpi/polydance_mark.png'));
    const res = 'app/android/app/src/main/res';
    const icons = {
      mac: 'mac/App/Resources/AppIcon.icns',
      iphone: 'ios/App/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png',
      visionpro: ['Front', 'Back'].map((layer) => `visionos/App/Resources/Assets.xcassets/AppIcon.solidimagestack/${layer}.solidimagestacklayer/Content.imageset/${layer}.png`),
      headsets: ['background', 'foreground', 'monochrome'].map((layer) => `${res}/drawable-nodpi/launcher_${layer}.png`),
      homepage: ['site/assets/icon-512.png', 'site/assets/favicon.png'],
    };
    expect(Object.keys(record.files)).toEqual(expect.arrayContaining(Object.values(icons).flat()));
    for (const [file, hash] of Object.entries(record.files)) expect(await sha(file), `${file} is not the icon design/icons.py drew; ${redraw}`).toBe(hash);

    // And each platform still points at it.
    expect(await read('mac/build.sh')).toContain('App/Resources/AppIcon.icns');
    expect(await read('ios/App/Resources/Assets.xcassets/AppIcon.appiconset/Contents.json')).toContain('"filename" : "AppIcon.png"');
    const stack = 'visionos/App/Resources/Assets.xcassets/AppIcon.solidimagestack';
    expect(JSON.parse(await read(`${stack}/Contents.json`)).layers).toEqual([{ filename: 'Front.solidimagestacklayer' }, { filename: 'Back.solidimagestacklayer' }]);
    expect(await read('visionos/project.yml')).toContain('ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon');
    expect(await read(`${res}/../AndroidManifest.xml`)).toContain('android:icon="@mipmap/ic_launcher"');
    const adaptive = await read(`${res}/mipmap-anydpi/ic_launcher.xml`);
    for (const layer of ['background', 'foreground', 'monochrome']) expect(adaptive).toContain(`<${layer} android:drawable="@drawable/launcher_${layer}" />`);
    for (const page of ['site/index.html', 'site/404.html']) expect(await read(page)).toMatch(/<link rel="icon" [^>]*href="\/?assets\/favicon\.png">/);
    expect(await read('site/index.html')).toContain('<link rel="apple-touch-icon" href="assets/icon-512.png">');
    expect(await sha('store-assets/polydance/upload/icon-512x512.png'), "the store's icon is the homepage's; run store-assets/polydance/build.py").toBe(
      record.files['site/assets/icon-512.png'],
    );
  });
});
