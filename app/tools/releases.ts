/**
 * One release, every headset (docs/RELEASING.md). From 2026-10-08 Quest builds went to Meta's Alpha from a
 * branch while the Android XR build came from main, so on 2026-10-13 the AURA ran 0.14.0 when Quest had
 * 0.15.2. A store build now comes only from main's committed tip and builds every flavor together; the
 * ledger, app/releases.json, records it and each place it went. `status` compares the ledger and the
 * connected headsets with the source and says what is behind. The ledger is checked in so every worktree
 * and session reads the same history; it holds versions, commits, file names and hashes, never secrets.
 * Everything here is pure, so the rules are tested without git, Gradle or a headset.
 *
 * Since 2026-11-12 the Vision Pro is the third headset (docs/VISIONOS.md, Robin: "it should follow the same
 * pipeline so that updates to any of the versions get copied across"): a release also builds visionos/ at the same
 * commit and version, its zipped .app is an artifact beside the APKs, an install with devicectl is a delivery, and
 * `status` asks the paired Vision Pro what it has. Releases recorded before then have no Vision Pro build.
 */
import { z } from 'zod';
import { PLATFORMS } from './platform.js';

/** Every headset a release goes to: the Android app's two flavors (platform.ts) and the Vision Pro. */
export const releasePlatformSchema = z.enum(['quest', 'android-xr', 'visionos']);
export type ReleasePlatform = z.infer<typeof releasePlatformSchema>;
export const RELEASE_PLATFORMS: Record<ReleasePlatform, { label: string; deliver: string }> = {
  quest: { label: PLATFORMS.quest.label, deliver: 'npm run app -- upload --platform quest' },
  'android-xr': { label: PLATFORMS['android-xr'].label, deliver: 'Install it on the headset, or upload it to Play' },
  visionos: { label: 'Vision Pro', deliver: 'npm run app -- install --platform visionos' },
};

const hex = (n: number) => z.string().regex(new RegExp(`^[0-9a-f]{${n}}$`));
const artifactSchema = z.object({
  platform: releasePlatformSchema,
  variant: z.enum(['release', 'debug']),
  /** An Android package or bundle, or the Vision Pro's .app zipped with ditto. */
  kind: z.enum(['apk', 'aab', 'app']),
  file: z.string().regex(/^[A-Za-z0-9._-]+$/),
  sha256: hex(64),
}).strict();
/**
 * Where a build went: a store channel (meta:ALPHA, play:internal), a headset over adb (adb:Android XR Puck), or a
 * Vision Pro over devicectl (devicectl:RealityDevice14,1).
 */
const deliverySchema = z.object({
  platform: releasePlatformSchema,
  to: z.string().regex(/^(meta|play|adb|devicectl):[A-Za-z0-9 _.,-]{1,60}$/),
  at: z.iso.datetime(),
  ref: z.string().max(80).optional(),
}).strict();
const releaseSchema = z.object({
  versionCode: z.number().int().positive(),
  versionName: z.string().min(1).max(40),
  commit: hex(40),
  builtAt: z.iso.datetime(),
  artifacts: z.array(artifactSchema).min(1),
  deliveries: z.array(deliverySchema),
}).strict();
export const ledgerSchema = z.object({ releases: z.array(releaseSchema) }).strict();
export type Ledger = z.infer<typeof ledgerSchema>;
export type Release = z.infer<typeof releaseSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type Delivery = z.infer<typeof deliverySchema>;

export const ANDROID_XR_SUFFIX = '-androidxr';
const short = (commit: string) => commit.slice(0, 7);

/** The version every flavor shares, from app/android/app/build.gradle.kts's defaultConfig. */
export function parseGradleVersion(text: string): { versionCode: number; versionName: string } {
  const code = text.match(/^\s*versionCode\s*=\s*(\d+)\s*$/m)?.[1];
  const name = text.match(/^\s*versionName\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (!code || !name) throw new Error('build.gradle.kts has no versionCode/versionName in defaultConfig');
  return { versionCode: Number(code), versionName: name };
}

/** A store build comes from main's committed tip: from anywhere else it ships work the other headset's build lacks. */
export function sourceProblems(s: { head: string; main?: string; dirty: boolean }): string[] {
  const p: string[] = [];
  if (s.dirty) p.push('commit everything first: a dirty tree is not a reproducible release');
  if (!s.main) p.push('there is no main branch to release from');
  else if (s.head !== s.main) {
    p.push(`HEAD ${short(s.head)} is not main's tip ${short(s.main)}. Merge to main and release from there, so the next build for every headset has the same work (docs/RELEASING.md)`);
  }
  return p;
}

/** versionCode only grows. Rebuilding the same code from the same commit replaces a release nothing has received yet. */
export function versionProblems(ledger: Ledger, versionCode: number, commit: string): string[] {
  const newest = latest(ledger);
  if (!newest || versionCode > newest.versionCode) return [];
  const same = ledger.releases.find(r => r.versionCode === versionCode);
  if (same && same.commit === commit && same.deliveries.length === 0) return [];
  return [`versionCode ${versionCode} is not above the newest release, ${newest.versionName} (${newest.versionCode}) from ${short(newest.commit)}; raise versionCode and versionName in app/android/app/build.gradle.kts`];
}

/**
 * Adds a release that has every headset's build. `skip` names the one that may be missing, only the Vision Pro
 * (`release --skip-visionos`, Robin 2026-11-19); `drift` then reports it as behind. The Android flavors never skip.
 */
export function addRelease(ledger: Ledger, release: Release, skip: 'visionos'[] = []): Ledger {
  const problems = versionProblems(ledger, release.versionCode, release.commit);
  if (problems.length) throw new Error(problems.join('; '));
  for (const platform of Object.keys(RELEASE_PLATFORMS) as ReleasePlatform[]) {
    if (platform === 'visionos' && skip.includes(platform)) continue;
    if (!release.artifacts.some(a => a.platform === platform && a.variant === 'release')) throw new Error(`a release needs a ${platform} release build`);
  }
  return ledgerSchema.parse({ releases: [...ledger.releases.filter(r => r.versionCode !== release.versionCode), release].sort((a, b) => a.versionCode - b.versionCode) });
}

export function latest(ledger: Ledger): Release | undefined {
  return ledger.releases.reduce<Release | undefined>((best, r) => (!best || r.versionCode > best.versionCode ? r : best), undefined);
}

/** The release and artifact a file belongs to, by its hash; a file built anywhere else is not a release. */
export function findArtifact(ledger: Ledger, sha256: string): { release: Release; artifact: Artifact } | undefined {
  for (const release of ledger.releases) {
    const artifact = release.artifacts.find(a => a.sha256 === sha256);
    if (artifact) return { release, artifact };
  }
  return undefined;
}

export function addDelivery(ledger: Ledger, sha256: string, delivery: Omit<Delivery, 'platform'>): Ledger {
  const found = findArtifact(ledger, sha256);
  if (!found) throw new Error('this file is not in app/releases.json; build releases with npm run app -- release');
  const entry = { ...delivery, platform: found.artifact.platform };
  return ledgerSchema.parse({
    releases: ledger.releases.map(r => (r === found.release ? { ...r, deliveries: [...r.deliveries, entry] } : r)),
  });
}

/** `dumpsys package net.polydance.capture`: what is installed, or nothing. */
export function parseInstalled(text: string): { versionCode: number; versionName: string } | undefined {
  const code = text.match(/\bversionCode=(\d+)/)?.[1];
  const name = text.match(/\bversionName=(\S+)/)?.[1];
  return code && name ? { versionCode: Number(code), versionName: name } : undefined;
}

/**
 * The Vision Pro's Info.plist against the release it is built for: Polydance for Vision Pro, the headsets' version
 * and build number, and the release's own commit with nothing uncommitted in it (visionos/build.sh writes
 * PolydanceCommit, with -dirty when the tree differed).
 */
export function visionAppProblems(info: Record<string, unknown>, want: { versionName: string; versionCode: number; commit: string }): string[] {
  const p: string[] = [];
  if (info.CFBundleIdentifier !== 'net.polydance.capture.visionpro') p.push(`the .app is ${String(info.CFBundleIdentifier)}, not net.polydance.capture.visionpro`);
  if (info.CFBundleShortVersionString !== want.versionName) p.push(`its version is ${String(info.CFBundleShortVersionString)}, not ${want.versionName}`);
  if (info.CFBundleVersion !== String(want.versionCode)) p.push(`its build number is ${String(info.CFBundleVersion)}, not ${want.versionCode}`);
  if (info.PolydanceCommit !== short(want.commit)) p.push(`it says it was built from ${String(info.PolydanceCommit)}, not ${short(want.commit)}`);
  return p;
}

/** visionos/build.sh installed: {device, model, os, installed, version?, build?}. */
export const visionInstalledSchema = z.object({
  device: z.string(), model: z.string(), os: z.string(), installed: z.boolean(),
  version: z.string().nullable().optional(), build: z.string().nullable().optional(),
}).strict();

export interface HeadsetSeen { label: string; platform?: ReleasePlatform; installed?: { versionCode: number; versionName: string } }
export interface Finding { level: 'ok' | 'note' | 'behind'; text: string }

/**
 * What is behind what. The question that went unasked on 2026-10-13: does every headset have the newest
 * release? A platform with no delivery of it, an older delivery than another platform, or a connected
 * headset on an older build or the other platform's flavor is 'behind'.
 */
export function drift(input: { ledger: Ledger; source?: { versionCode: number; versionName: string; head: string; onMain: boolean }; headsets: HeadsetSeen[] }): Finding[] {
  const out: Finding[] = [];
  const newest = latest(input.ledger);
  const platforms = (Object.keys(RELEASE_PLATFORMS) as ReleasePlatform[]).map(id => ({ id, ...RELEASE_PLATFORMS[id] }));
  const named = (r: Release, platform: ReleasePlatform) => `${r.versionName}${platform === 'android-xr' ? ANDROID_XR_SUFFIX : ''} (${r.versionCode})`;
  if (input.source) {
    const s = input.source;
    out.push({ level: 'note', text: `source: ${s.versionName} (${s.versionCode}) at ${short(s.head)}${s.onMain ? ', main' : ', not main: a store build cannot come from here'}` });
    if (newest && s.versionCode < newest.versionCode) out.push({ level: 'behind', text: `this checkout is older than the newest release ${newest.versionName} (${newest.versionCode}); merge main` });
  }
  if (!newest) {
    out.push({ level: 'note', text: 'no releases recorded in app/releases.json yet' });
  } else {
    out.push({ level: 'note', text: `newest release: ${newest.versionName} (${newest.versionCode}) from ${short(newest.commit)}, built ${newest.builtAt.slice(0, 10)}` });
    const newestDelivered = new Map<ReleasePlatform, Release>();
    for (const r of input.ledger.releases) for (const d of r.deliveries) {
      const seen = newestDelivered.get(d.platform);
      if (!seen || r.versionCode > seen.versionCode) newestDelivered.set(d.platform, r);
    }
    for (const p of platforms) {
      const sent = newest.deliveries.filter(d => d.platform === p.id).map(d => d.to);
      if (!newest.artifacts.some(a => a.platform === p.id)) {
        out.push({ level: 'behind', text: `${p.label}: ${named(newest, p.id)} has no ${p.label} build; it was released without one (before the ${p.label} had one, or with --skip-${p.id}). The next npm run app -- release builds it (docs/RELEASING.md)` });
      } else if (sent.length) out.push({ level: 'ok', text: `${p.label}: ${named(newest, p.id)} went to ${[...new Set(sent)].join(', ')}` });
      else {
        const last = newestDelivered.get(p.id);
        out.push({ level: 'behind', text: `${p.label}: ${named(newest, p.id)} has gone nowhere yet${last ? `; the newest it received is ${named(last, p.id)}` : ''}. ${p.deliver} (docs/RELEASING.md)` });
      }
    }
  }
  for (const h of input.headsets) {
    if (!h.platform) { out.push({ level: 'note', text: `${h.label}: not a Quest or Android XR headset; skipped` }); continue; }
    const p = RELEASE_PLATFORMS[h.platform];
    if (!h.installed) { out.push({ level: 'behind', text: `${h.label} (${p.label}): Polydance is not installed` }); continue; }
    const xr = h.installed.versionName.endsWith(ANDROID_XR_SUFFIX);
    if (h.platform !== 'visionos' && xr !== (h.platform === 'android-xr')) {
      out.push({ level: 'behind', text: `${h.label} (${p.label}): ${h.installed.versionName} is the other platform's build; install the ${p.label} flavor` });
    } else if (newest && h.installed.versionCode < newest.versionCode) {
      out.push({ level: 'behind', text: `${h.label} (${p.label}): ${h.installed.versionName} (${h.installed.versionCode}), ${newest.versionCode - h.installed.versionCode} version code(s) behind ${named(newest, h.platform)}` });
    } else {
      out.push({ level: 'ok', text: `${h.label} (${p.label}): ${h.installed.versionName} (${h.installed.versionCode})${newest && h.installed.versionCode > newest.versionCode ? ', newer than the newest release (a development build)' : ''}` });
    }
  }
  return out;
}
