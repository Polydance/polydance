/** One release for every headset: the ledger's rules and the drift report, without git, Gradle or a headset. */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  addDelivery, addRelease, drift, findArtifact, ledgerSchema, parseGradleVersion, parseInstalled, sourceProblems, versionProblems,
  visionAppProblems, visionInstalledSchema, type Artifact, type Ledger, type Release,
} from '../app/tools/releases.js';

const commit = (c: string) => c.repeat(40).slice(0, 40);
const sha = (c: string) => c.repeat(64).slice(0, 64);
const artifacts = (code: number): Artifact[] => [
  { platform: 'quest', variant: 'release', kind: 'apk', file: `polydance-quest-release-${code}.apk`, sha256: sha(`${code}a`) },
  { platform: 'android-xr', variant: 'release', kind: 'apk', file: `polydance-android-xr-release-${code}.apk`, sha256: sha(`${code}b`) },
  { platform: 'android-xr', variant: 'debug', kind: 'apk', file: `polydance-android-xr-debug-${code}.apk`, sha256: sha(`${code}c`) },
  { platform: 'android-xr', variant: 'release', kind: 'aab', file: `polydance-android-xr-release-${code}.aab`, sha256: sha(`${code}d`) },
  { platform: 'visionos', variant: 'release', kind: 'app', file: `polydance-visionos-release-${code}.zip`, sha256: sha(`${code}e`) },
];
const release = (code: number, c = 'a', deliveries: Release['deliveries'] = []): Release => ({
  versionCode: code, versionName: `0.15.${code - 18}`, commit: commit(c), builtAt: '2026-10-13T18:00:00.000Z', artifacts: artifacts(code), deliveries,
});
const at = '2026-10-13T19:00:00.000Z';
const empty: Ledger = { releases: [] };

describe('release source', () => {
  it('builds only from main\'s committed tip', () => {
    expect(sourceProblems({ head: commit('a'), main: commit('a'), dirty: false })).toEqual([]);
    expect(sourceProblems({ head: commit('a'), main: commit('a'), dirty: true })).toEqual([expect.stringMatching(/dirty tree/)]);
    expect(sourceProblems({ head: commit('b'), main: commit('a'), dirty: false })).toEqual([expect.stringMatching(/not main's tip aaaaaaa/)]);
    expect(sourceProblems({ head: commit('b'), dirty: false })).toEqual([expect.stringMatching(/no main branch/)]);
  });

  it('reads the one shared version from the real Gradle file', async () => {
    const version = parseGradleVersion(await readFile('app/android/app/build.gradle.kts', 'utf8'));
    expect(version.versionCode).toBeGreaterThanOrEqual(20);
    expect(version.versionName).toMatch(/^\d+\.\d+\.\d+$/);
    expect(() => parseGradleVersion('android {}')).toThrow(/no versionCode/);
  });
});

describe('release ledger', () => {
  it('only grows, and a rebuild of an undelivered release from the same commit replaces it', () => {
    const one = addRelease(empty, release(21));
    expect(versionProblems(one, 22, commit('b'))).toEqual([]);
    expect(versionProblems(one, 21, commit('a'))).toEqual([]);
    expect(addRelease(one, { ...release(21), builtAt: at }).releases).toHaveLength(1);
    expect(versionProblems(one, 21, commit('b'))).toEqual([expect.stringMatching(/raise versionCode/)]);
    expect(versionProblems(one, 20, commit('b'))).toEqual([expect.stringMatching(/not above the newest release, 0\.15\.3 \(21\)/)]);
    const delivered = addDelivery(one, sha('21a'), { to: 'meta:ALPHA', at });
    expect(versionProblems(delivered, 21, commit('a'))).toEqual([expect.stringMatching(/raise versionCode/)]);
  });

  it('refuses a release missing a platform', () => {
    expect(() => addRelease(empty, { ...release(21), artifacts: artifacts(21).filter(a => a.platform === 'quest') })).toThrow(/android-xr release build/);
  });

  it('records deliveries only for its own files, under the file\'s platform', () => {
    const ledger = addRelease(empty, release(21));
    expect(() => addDelivery(ledger, sha('ff'), { to: 'meta:ALPHA', at })).toThrow(/not in app\/releases.json/);
    const next = addDelivery(ledger, sha('21c'), { to: 'adb:Android XR Puck', at });
    expect(next.releases[0].deliveries).toEqual([{ platform: 'android-xr', to: 'adb:Android XR Puck', at }]);
    expect(findArtifact(next, sha('21b'))?.artifact.kind).toBe('apk');
  });

  it('fails closed on an unexpected shape', () => {
    expect(ledgerSchema.safeParse({ releases: [{ ...release(21), extra: true }] }).success).toBe(false);
    expect(ledgerSchema.safeParse({ releases: [{ ...release(21), commit: 'main' }] }).success).toBe(false);
    expect(ledgerSchema.safeParse({ releases: [{ ...release(21), deliveries: [{ platform: 'quest', to: 'email:robin', at }] }] }).success).toBe(false);
  });
});

describe('drift', () => {
  const dumpsys = `Packages:
  Package [net.polydance.capture] (1a2b3c):
    versionCode=14 minSdk=30 targetSdk=34
    versionName=0.14.0-androidxr
`;

  it('reads the installed version from dumpsys, and nothing when absent', () => {
    expect(parseInstalled(dumpsys)).toEqual({ versionCode: 14, versionName: '0.14.0-androidxr' });
    expect(parseInstalled('Unable to find package: net.polydance.capture')).toBeUndefined();
  });

  it('says what went wrong on 2026-10-13: Quest on the new build, the AURA on 0.14.0', () => {
    const ledger = addDelivery(addRelease(empty, release(20)), sha('20a'), { to: 'meta:ALPHA', at });
    const findings = drift({
      ledger,
      headsets: [{ label: 'Android XR Puck 192.168.1.20:37000', platform: 'android-xr', installed: parseInstalled(dumpsys) }],
    });
    const behind = findings.filter(f => f.level === 'behind').map(f => f.text);
    expect(behind).toEqual([
      expect.stringMatching(/^Android XR: 0\.15\.2-androidxr \(20\) has gone nowhere yet/),
      // Since 2026-11-12 a release is the Vision Pro's too, and this one reached no Vision Pro either.
      expect.stringMatching(/^Vision Pro: 0\.15\.2 \(20\) has gone nowhere yet\. npm run app -- install --platform visionos/),
      expect.stringMatching(/Android XR Puck .*0\.14\.0-androidxr \(14\), 6 version code\(s\) behind 0\.15\.2-androidxr \(20\)/),
    ]);
    expect(findings).toContainEqual({ level: 'ok', text: 'Quest: 0.15.2 (20) went to meta:ALPHA' });
  });

  it('is quiet when every platform and headset has the newest release', () => {
    let ledger = addRelease(addRelease(empty, release(20)), release(21, 'b'));
    ledger = addDelivery(ledger, sha('21a'), { to: 'meta:ALPHA', at });
    ledger = addDelivery(ledger, sha('21c'), { to: 'adb:Android XR Puck', at });
    ledger = addDelivery(ledger, sha('21e'), { to: 'devicectl:RealityDevice14,1', at });
    const findings = drift({
      ledger, source: { versionCode: 21, versionName: '0.15.3', head: commit('b'), onMain: true },
      headsets: [
        { label: 'Quest 3 1WMHH', platform: 'quest', installed: { versionCode: 21, versionName: '0.15.3' } },
        { label: 'Android XR Puck usb', platform: 'android-xr', installed: { versionCode: 22, versionName: '0.15.4-androidxr' } },
        { label: 'Apple Vision Pro RealityDevice14,1', platform: 'visionos', installed: { versionCode: 21, versionName: '0.15.3' } },
      ],
    });
    expect(findings.filter(f => f.level === 'behind')).toEqual([]);
    expect(findings.map(f => f.text)).toContain('Android XR Puck usb (Android XR): 0.15.4-androidxr (22), newer than the newest release (a development build)');
  });

  it('flags the other platform\'s flavor, a missing install, a stale checkout, and a platform that never received anything', () => {
    const ledger = addDelivery(addRelease(empty, release(21)), sha('21a'), { to: 'meta:ALPHA', at });
    const findings = drift({
      ledger, source: { versionCode: 20, versionName: '0.15.2', head: commit('c'), onMain: false },
      headsets: [
        { label: 'Quest 3 x', platform: 'quest', installed: { versionCode: 21, versionName: '0.15.3-androidxr' } },
        { label: 'AURA y', platform: 'android-xr' },
        { label: 'Pixel z' },
      ],
    }).map(f => `${f.level} ${f.text}`);
    expect(findings).toEqual(expect.arrayContaining([
      expect.stringMatching(/^note source: 0\.15\.2 \(20\) at ccccccc, not main/),
      expect.stringMatching(/^behind this checkout is older than the newest release/),
      expect.stringMatching(/^behind Android XR: 0\.15\.3-androidxr \(21\) has gone nowhere yet\. Install/),
      expect.stringMatching(/^behind Quest 3 x \(Quest\): 0\.15\.3-androidxr is the other platform's build/),
      'behind AURA y (Android XR): Polydance is not installed',
      'note Pixel z: not a Quest or Android XR headset; skipped',
    ]));
  });
});

describe('the Vision Pro in the release (docs/VISIONOS.md)', () => {
  it('a release needs its Vision Pro build, and a devicectl delivery is recorded under it', () => {
    expect(() => addRelease(empty, { ...release(21), artifacts: artifacts(21).filter(a => a.platform !== 'visionos') })).toThrow(/visionos release build/);
    // --skip-visionos (2026-11-19): recorded without it, and drift says the Vision Pro has no build of it.
    const skipped = addRelease(empty, { ...release(21), artifacts: artifacts(21).filter(a => a.platform !== 'visionos') }, ['visionos']);
    expect(drift({ ledger: skipped, headsets: [] }).map(f => `${f.level} ${f.text}`))
      .toContainEqual(expect.stringMatching(/^behind Vision Pro: 0\.15\.3 \(21\) has no Vision Pro build; it was released without one/));
    expect(() => addRelease(empty, { ...release(21), artifacts: artifacts(21).filter(a => a.platform !== 'quest') }, ['visionos'])).toThrow(/quest release build/);
    const next = addDelivery(addRelease(empty, release(21)), sha('21e'), { to: 'devicectl:RealityDevice14,1', at });
    expect(next.releases[0].deliveries).toEqual([{ platform: 'visionos', to: 'devicectl:RealityDevice14,1', at }]);
    expect(findArtifact(next, sha('21e'))?.artifact.kind).toBe('app');
  });

  it('says a release from before the Vision Pro has no build for it, and a Vision Pro behind by its build number', () => {
    // The ledger as it was on 2026-11-12: Android only.
    const before = ledgerSchema.parse({ releases: [{ ...release(21), artifacts: artifacts(21).filter(a => a.platform !== 'visionos') }] });
    const old = drift({ ledger: before, headsets: [] }).map(f => `${f.level} ${f.text}`);
    expect(old).toContainEqual(expect.stringMatching(/^behind Vision Pro: 0\.15\.3 \(21\) has no Vision Pro build; it was released without one/));
    const ledger = addRelease(empty, release(21));
    const findings = drift({ ledger, headsets: [{ label: 'Apple Vision Pro x', platform: 'visionos', installed: { versionCode: 19, versionName: '0.15.1' } }] })
      .map(f => `${f.level} ${f.text}`);
    expect(findings).toEqual(expect.arrayContaining([
      expect.stringMatching(/^behind Vision Pro: 0\.15\.3 \(21\) has gone nowhere yet\. npm run app -- install --platform visionos/),
      'behind Apple Vision Pro x (Vision Pro): 0.15.1 (19), 2 version code(s) behind 0.15.3 (21)',
    ]));
    expect(findings.some(f => f.includes("other platform's build"))).toBe(false);
  });

  it('checks the .app is the release it says it is', () => {
    const want = { versionName: '0.21.0', versionCode: 28, commit: commit('a8e3c7d') };
    const good = { CFBundleIdentifier: 'net.polydance.capture.visionpro', CFBundleShortVersionString: '0.21.0', CFBundleVersion: '28', PolydanceCommit: 'a8e3c7d' };
    expect(visionAppProblems(good, want)).toEqual([]);
    expect(visionAppProblems({ ...good, PolydanceCommit: 'a8e3c7d-dirty' }, want)).toEqual([expect.stringMatching(/built from a8e3c7d-dirty, not a8e3c7d/)]);
    expect(visionAppProblems({ ...good, CFBundleVersion: '27', CFBundleIdentifier: 'net.polydance.capture.iphone' }, want)).toHaveLength(2);
  });

  it('reads what the Vision Pro reports, strictly', () => {
    expect(visionInstalledSchema.parse({ device: 'Apple Vision Pro', model: 'RealityDevice14,1', os: '26.6', installed: true, version: '0.21.0', build: '28' }).build).toBe('28');
    expect(visionInstalledSchema.safeParse({ device: 'x', model: 'y', os: 'z', installed: true, token: 'no' }).success).toBe(false);
  });
});
