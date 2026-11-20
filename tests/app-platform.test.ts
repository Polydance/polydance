/** Platform policy and real CLI subprocesses against a private, synthetic adb; no hardware/network. */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AdbDevice } from '../src/adb.js';
import { exec } from '../src/exec.js';
import { sha256File } from '../src/fsx.js';
import { chooseDevice, connectFailureHint } from '../app/tools/device.js';
import { assertPlatform, buildTarget, connectTarget, platformFor, PLATFORMS } from '../app/tools/platform.js';

const quest = { serial: 'QUEST_USB', state: 'device', model: 'Quest_3' };
const puck = { serial: 'PUCK_USB', state: 'device', model: 'Android_XR_Puck' };
const aura = { serial: 'AURA_USB', state: 'device', model: 'XREAL_AURA' };
const xr = PLATFORMS['android-xr'];

describe('app platform policy', () => {
  it('defaults to Quest, accepts Android XR, and rejects misspelled ids', () => {
    expect(platformFor()).toBe(PLATFORMS.quest);
    expect(platformFor('android-xr')).toBe(xr);
    for (const value of ['androidXr', '', 'xreal', 'android', null]) expect(() => platformFor(value)).toThrow(/--platform must be/);
  });

  it.each([
    ['quest', false, 'assembleQuestDebug', 'quest/debug/app-quest-debug.apk'],
    ['quest', true, 'assembleQuestRelease', 'quest/release/app-quest-release.apk'],
    ['android-xr', false, 'assembleAndroidXrDebug', 'androidXr/debug/app-androidXr-debug.apk'],
    ['android-xr', true, 'assembleAndroidXrRelease', 'androidXr/release/app-androidXr-release.apk'],
  ])('selects the %s release=%s task and APK', (id, release, task, suffix) => {
    const target = buildTarget(platformFor(id), release as boolean);
    expect(target.task).toBe(task);
    expect(target.apk).toBe(join(process.cwd(), 'app/android/app/build/outputs/apk', suffix as string));
  });

  it('recognizes only the supported XR models, normalizing spaces/underscores/case', () => {
    for (const model of ['Android_XR_Puck', ' Android XR Puck ', 'XREAL_AURA', 'xreal  aura']) expect(xr.matchesModel(model)).toBe(true);
    expect(xr.matchesModel('aura', 'XREAL')).toBe(true);
    for (const model of ['Air 2', 'Beam', 'aura', 'Quest_3', 'Android XR Unknown']) expect(xr.matchesModel(model)).toBe(false);
    expect(xr.matchesModel('Air 2', 'XREAL')).toBe(false);
  });

  it('selects only the requested platform even when a Quest is the sole ready device', () => {
    expect(chooseDevice([quest, puck], undefined).serial).toBe(quest.serial);
    expect(chooseDevice([quest, puck], undefined, 'any', undefined, xr).serial).toBe(puck.serial);
    expect(() => chooseDevice([quest], undefined, 'any', undefined, xr)).toThrow(/no Android XR/);
    expect(() => chooseDevice([quest], quest.serial, 'any', undefined, xr)).toThrow(/not a recognized Android XR/);
    expect(() => chooseDevice([puck, aura], undefined, 'any', undefined, xr)).toThrow(/several Android XR/);
    expect(() => chooseDevice([{ ...puck, state: 'unauthorized' }], undefined, 'any', undefined, xr)).toThrow(/unauthorized/);
  });

  it('coalesces matching nonempty hardware ids, prefers USB, and leaves empty ids ambiguous', () => {
    const wifi = { ...puck, serial: '10.0.0.1:41234' };
    expect(chooseDevice([wifi, puck], undefined, 'any', new Map([[wifi.serial, 'same'], [puck.serial, 'same']]), xr)).toEqual(puck);
    for (const id of ['', '   ']) {
      expect(() => chooseDevice([wifi, puck], undefined, 'any', new Map([[wifi.serial, id], [puck.serial, id]]), xr)).toThrow(/several/);
    }
    expect(() => chooseDevice([wifi, puck], undefined, 'any', new Map([[puck.serial, 'one']]), xr)).toThrow(/several/);
    expect(() => chooseDevice([wifi, puck, aura], undefined, 'any', new Map([[wifi.serial, 'same'], [puck.serial, 'same'], [aura.serial, 'other']]), xr)).toThrow(/several/);
  });

  it('rejects explicit network serials when USB is required, even with an override', () => {
    for (const serial of ['10.0.0.1:5555', 'adb-123._adb-tls-connect._tcp']) {
      expect(() => chooseDevice([{ ...quest, serial }], serial, 'usb')).toThrow(/network transport/);
      expect(() => chooseDevice([{ ...quest, serial }], serial, 'usb', undefined, xr, true)).toThrow(/network transport/);
    }
  });

  it('only lets an explicit any-device target bypass platform identity, not readiness', () => {
    const unknown = { ...aura, model: 'engineering_board' };
    expect(() => chooseDevice([unknown], undefined, 'any', undefined, xr, true)).toThrow(/explicitly select/);
    expect(chooseDevice([unknown], unknown.serial, 'any', undefined, xr, true)).toEqual(unknown);
    expect(() => chooseDevice([{ ...unknown, state: 'offline' }], unknown.serial, 'any', undefined, xr, true)).toThrow(/offline/);
    expect(() => assertPlatform(xr, 's', 'Quest 3', 'Meta')).toThrow(/not a recognized Android XR/);
    expect(() => assertPlatform(PLATFORMS.quest, 's', 'Unknown', 'Meta')).toThrow(/not a recognized Quest/);
    expect(() => assertPlatform(xr, 's', 'engineering', 'XREAL', true)).not.toThrow();
  });

  it('requires an XR connection port, keeps the Quest default, and validates endpoints', () => {
    expect(connectTarget('10.0.0.2', PLATFORMS.quest)).toBe('10.0.0.2:5555');
    expect(connectTarget('headset.local:41235', xr)).toBe('headset.local:41235');
    expect(connectTarget('[::1]:40000', xr)).toBe('[::1]:40000');
    expect(() => connectTarget('10.0.0.2', xr)).toThrow(/explicit connection port/);
    for (const value of ['host:0', 'host:65536', 'host:-1', 'host:abc', '::1', 'host;', 'host:22\n', '[host]:42', '-host:42']) {
      expect(() => connectTarget(value, xr)).toThrow(/--connect/);
    }
    expect(connectFailureHint('Connection refused', xr)).toMatch(/adb pair IP:PAIRING_PORT.*adb connect IP:CONNECT_PORT/);
  });
});

interface FakeDevice extends AdbDevice { modelProp?: string; manufacturer?: string; hardware?: string; installed?: { versionCode: number; versionName: string } }
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function fixture(devices: FakeDevice[] = [quest, puck], extras: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'polycap-platform-'));
  dirs.push(dir);
  const adb = join(dir, 'adb'), config = join(dir, 'fixture.json'), log = join(dir, 'calls.jsonl'), apk = join(dir, 'test.apk');
  // visionos/build.sh's stand-in: the fixture's `vision` is the Vision Pro it can reach, or none (exit 2), so no test asks a real one.
  const vision = join(dir, 'visionos-build');
  await writeFile(vision, `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2), f = JSON.parse(fs.readFileSync(process.env.APP_FIXTURE, 'utf8'));
fs.appendFileSync(process.env.APP_LOG, JSON.stringify(['visionos', ...a]) + '\\n');
if (!f.vision) { console.error('no Vision Pro is reachable now'); process.exit(2); }
if (a[0] === 'installed') console.log(JSON.stringify(f.vision));
else if (a[0] === 'install' && a[1] === '--app' && !fs.existsSync(a[2] + '/Info.plist')) { console.error('no app at ' + a[2]); process.exit(4); }
`, { mode: 0o700 });
  await writeFile(config, JSON.stringify({ devices, ...extras }), { mode: 0o600 });
  await writeFile(log, '', { mode: 0o600 });
  await writeFile(apk, 'synthetic APK', { mode: 0o600 });
  await writeFile(adb, `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2), f = JSON.parse(fs.readFileSync(process.env.APP_FIXTURE, 'utf8'));
fs.appendFileSync(process.env.APP_LOG, JSON.stringify(a) + '\\n');
const out = value => console.log(value ?? '');
if (a[0] === 'devices') {
  out('List of devices attached');
  for (const d of f.devices) out(d.serial + ' ' + d.state + (d.model ? ' model:' + d.model : ''));
} else if (a[0] === 'connect') {
  out('connected to ' + a[1]);
} else if (a[0] === '-s') {
  const d = f.devices.find(d => d.serial === a[1]);
  if (!d) process.exit(3);
  const cmd = a[3] || '';
  if (a[2] === 'install') out('Success');
  else if (a[2] !== 'shell') process.exit(4);
  else if (cmd.startsWith('getprop ')) {
    out({ 'ro.product.model': d.modelProp ?? (d.model || '').replaceAll('_', ' '),
      'ro.product.manufacturer': d.manufacturer ?? (d.model?.startsWith('Quest') ? 'Meta' : 'XREAL'),
      'ro.serialno': d.hardware ?? '', 'ro.build.version.release': '14', 'ro.build.version.sdk': '34',
      'ro.build.display.id': 'synthetic' }[cmd.slice(8)]);
  } else if (cmd.startsWith('dumpsys package ')) {
    out(d.installed ? '    versionCode=' + d.installed.versionCode + ' minSdk=30 targetSdk=34\\n    versionName=' + d.installed.versionName : 'Unable to find package');
  } else if (cmd.startsWith('dumpsys')) out(f.recording ? 'RecorderService isForeground=true' : '');
  else if (cmd.startsWith("stat -c '%Y'")) out(f.growing ? '999' : '');
  else if (cmd === 'date +%s') out('1000');
  else if (cmd.startsWith('ls -1 ') || cmd.startsWith('pm path ')) out('');
  else if (cmd.startsWith('am start ')) {
    if (f.failConfigure && cmd.includes('.CONFIGURE')) { console.error(cmd); process.exit(5); }
    out('Starting intent');
  } else { console.error('unsupported fake shell: ' + cmd); process.exit(6); }
} else { console.error('unsupported fake adb'); process.exit(7); }
`, { mode: 0o700 });
  return {
    dir, apk,
    run: (args: string[], env: NodeJS.ProcessEnv = {}) => exec(process.execPath, ['--import', 'tsx', 'app/tools/cli.ts', ...args], {
      allowFailure: true, env: { ...process.env, POLYCAP_ADB: adb, APP_FIXTURE: config, APP_LOG: log, POLYCAP_RELEASE_LEDGER: join(dir, 'releases.json'), POLYCAP_VISIONOS_BUILD: vision, ...env },
    }),
    calls: async (): Promise<string[][]> => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    clear: () => writeFile(log, ''),
  };
}

const installs = (calls: string[][]) => calls.filter(c => c[2] === 'install');

describe('app platform CLI with fake adb', () => {
  it('installs on Quest by default and Android XR only when requested, preserving app id', async () => {
    const f = await fixture();
    const q = await f.run(['install', '--apk', f.apk, '--launch']);
    expect(q.code, q.stderr).toBe(0);
    expect(installs(await f.calls())[0][1]).toBe(quest.serial);
    await f.clear();
    const x = await f.run(['install', '--platform', 'android-xr', '--apk', f.apk, '--launch']);
    expect(x.code, x.stderr).toBe(0);
    expect(installs(await f.calls())[0][1]).toBe(puck.serial);
    expect((await f.calls()).some(c => c[3] === 'am start -n net.polydance.capture/.MainActivity')).toBe(true);
  });

  it('fails closed for wrong, unknown and ambiguous devices; --force does not bypass identity', async () => {
    for (const devices of [[quest], [puck, aura], [{ ...aura, model: 'Air_2' }]]) {
      const f = await fixture(devices);
      const result = await f.run(['install', '--platform', 'android-xr', '--apk', f.apk, '--force']);
      expect(result.code).not.toBe(0);
      expect(installs(await f.calls())).toEqual([]);
    }
    const f = await fixture([quest]);
    const result = await f.run(['install', '--platform', 'android-xr', '--device', quest.serial, '--apk', f.apk]);
    expect(result.stderr).toMatch(/not a recognized Android XR/);
    expect(installs(await f.calls())).toEqual([]);
  });

  it('checks actual model properties even if adb lists a matching model', async () => {
    const f = await fixture([{ ...puck, modelProp: 'Quest 3', manufacturer: 'Meta' }]);
    const result = await f.run(['install', '--platform', 'android-xr', '--apk', f.apk]);
    expect(result.stderr).toMatch(/not a recognized Android XR/);
    expect(installs(await f.calls())).toEqual([]);
  });

  it('recognizes an abbreviated AURA property only with XREAL manufacturer', async () => {
    const f = await fixture([{ ...aura, model: 'aura', manufacturer: 'XREAL' }]);
    const result = await f.run(['install', '--platform', 'android-xr', '--apk', f.apk]);
    expect(result.code, result.stderr).toBe(0);
    expect(installs(await f.calls())[0][1]).toBe(aura.serial);
  });

  it('allows an explicitly selected engineering device override, not an automatic unknown target', async () => {
    const f = await fixture([{ ...puck, model: 'engineering_board' }]);
    const args = ['install', '--platform', 'android-xr', '--apk', f.apk, '--any-device'];
    const refused = await f.run(args);
    expect(refused.stderr).toMatch(/explicitly select/);
    expect(installs(await f.calls())).toEqual([]);
    const allowed = await f.run([...args, '--device', puck.serial]);
    expect(allowed.code, allowed.stderr).toBe(0);
    expect(installs(await f.calls())).toHaveLength(1);
  });

  it.each(['recording', 'growing'])('preserves recording refusal from %s even with --any-device', async signal => {
    const f = await fixture([puck], { [signal]: true });
    const args = ['install', '--platform', 'android-xr', '--device', puck.serial, '--any-device', '--apk', f.apk];
    const result = await f.run(args);
    expect(result.stderr).toMatch(/recording right now/);
    expect(installs(await f.calls())).toEqual([]);
    const forced = await f.run([...args, '--force']);
    expect(forced.code, forced.stderr).toBe(0);
    expect(installs(await f.calls())).toHaveLength(1);
  });

  it('selects USB for duplicate transports but refuses unknown/empty hardware ids', async () => {
    const wifi = { ...puck, serial: '10.0.0.1:41234' };
    for (const hardware of ['same', '']) {
      const f = await fixture([{ ...wifi, hardware }, { ...puck, hardware }]);
      const result = await f.run(['install', '--platform', 'android-xr', '--apk', f.apk]);
      if (hardware) {
        expect(result.code, result.stderr).toBe(0);
        expect(installs(await f.calls())[0][1]).toBe(puck.serial);
      } else {
        expect(result.stderr).toMatch(/several Android XR/);
        expect(installs(await f.calls())).toEqual([]);
      }
    }
  });

  it('never invokes tcpip for XR wifi and rejects explicit Quest network transport for USB wifi', async () => {
    const f = await fixture([{ ...quest, serial: '10.0.0.1:5555' }]);
    const xrWifi = await f.run(['wifi', '--platform', 'android-xr']);
    expect(xrWifi.code).toBe(0);
    expect(xrWifi.stdout).toMatch(/adb pair IP:PAIRING_PORT.*adb connect IP:CONNECT_PORT/);
    expect(await f.calls()).toEqual([]);
    const questWifi = await f.run(['wifi', '--device', '10.0.0.1:5555']);
    expect(questWifi.stderr).toMatch(/network transport/);
    expect((await f.calls()).some(c => c.includes('tcpip'))).toBe(false);
  });

  it('requires XR connect ports before calling adb, and uses the explicit connection as target', async () => {
    const f = await fixture([quest, { ...puck, serial: '10.0.0.1:41234' }]);
    const args = ['install', '--platform', 'android-xr', '--apk', f.apk];
    const refused = await f.run([...args, '--connect', '10.0.0.1']);
    expect(refused.stderr).toMatch(/explicit connection port/);
    expect(await f.calls()).toEqual([]);
    const result = await f.run([...args, '--connect', '10.0.0.1:41234']);
    expect(result.code, result.stderr).toBe(0);
    expect((await f.calls())[0]).toEqual(['connect', '10.0.0.1:41234']);
    expect(installs(await f.calls())[0][1]).toBe('10.0.0.1:41234');
    const conflict = await f.run([...args, '--connect', '10.0.0.1:41234', '--device', quest.serial]);
    expect(conflict.stderr).toMatch(/either --connect or --device/);
  });

  it.each(['quest', 'android-xr'])('selects the %s default release APK path or explains how to build it', async id => {
    const f = await fixture();
    const result = await f.run(['install', '--platform', id, '--release']);
    const expected = buildTarget(platformFor(id), true).apk;
    // A developer may already have built this artifact; either path must still use the right flavor.
    if (result.code === 0) expect(installs(await f.calls())[0][4]).toBe(expected);
    else {
      expect(result.stderr).toContain(`no APK at ${expected}`);
      expect(result.stderr).toContain(`build --platform ${id} --release`);
    }
  });

  it.each(['pull', 'migrate'])('%s honors platform selection and never deletes source files', async command => {
    const f = await fixture();
    const result = await f.run([command, '--platform', 'android-xr']);
    expect(result.code, result.stderr).toBe(0);
    const calls = await f.calls();
    expect(calls.some(c => c[1] === puck.serial && /^(ls -1|pm path)/.test(c[3] ?? ''))).toBe(true);
    expect(calls.some(c => /\b(rm|mv)\b/.test(c[3] ?? ''))).toBe(false);
    const bad = await f.run([command, '--platform', 'android-xr', '--device', quest.serial]);
    expect(bad.stderr).toMatch(/not a recognized Android XR/);
  });

  it('configures the selected platform without leaking tokens, including echoed failure output', async () => {
    for (const failConfigure of [false, true]) {
      const f = await fixture(undefined, { failConfigure });
      const token = 'polycap_' + 'a'.repeat(64), file = join(f.dir, 'token');
      await writeFile(file, token, { mode: 0o600 });
      const args = ['configure', '--platform', 'android-xr', '--server', 'https://example.test', '--token-file', file];
      const result = await f.run(args);
      expect(result.code === 0).toBe(!failConfigure);
      expect(result.stdout + result.stderr).not.toContain(token);
      expect((await f.calls()).find(c => c[3]?.includes('.CONFIGURE'))?.[1]).toBe(puck.serial);
      await chmod(file, 0o644);
      await f.clear();
      const insecure = await f.run(args);
      expect(insecure.stderr).toMatch(/chmod 600/);
      expect(await f.calls()).toEqual([]);
    }
  });

  it('validates platform and build prerequisites without starting adb or Gradle', async () => {
    const f = await fixture();
    expect((await f.run(['pull', '--platform', 'androidXr'])).stderr).toMatch(/--platform must be/);
    const missing = await f.run(['build', '--platform', 'android-xr'], { JAVA_HOME: '', ANDROID_HOME: '' });
    expect(missing.stderr).toMatch(/JAVA_HOME.*JDK 17.*ANDROID_HOME/);
    const home = join(f.dir, 'fake-jdk');
    await mkdir(join(home, 'bin'), { recursive: true });
    const java = join(home, 'bin/java');
    await writeFile(java, `#!${process.execPath}\nconsole.error('openjdk version "21.0.1"');\n`, { mode: 0o700 });
    const wrong = await f.run(['build', '--platform', 'android-xr'], { JAVA_HOME: home, ANDROID_HOME: f.dir });
    expect(wrong.stderr).toMatch(/requires JDK 17/);
    expect(await f.calls()).toEqual([]);
  });
});

describe('release ledger through the CLI with fake adb', () => {
  const at = '2026-10-13T18:00:00.000Z';
  const ledgerWith = (sha256: string, deliveries: unknown[] = []) => JSON.stringify({ releases: [{
    versionCode: 20, versionName: '0.15.2', commit: 'a'.repeat(40), builtAt: at, deliveries,
    artifacts: [
      { platform: 'quest', variant: 'release', kind: 'apk', file: 'polydance-quest-release-0.15.2-20.apk', sha256: 'b'.repeat(64) },
      { platform: 'android-xr', variant: 'release', kind: 'apk', file: 'polydance-android-xr-release-0.15.2-20.apk', sha256: 'c'.repeat(64) },
      { platform: 'android-xr', variant: 'debug', kind: 'apk', file: 'polydance-android-xr-debug-0.15.2-20.apk', sha256 },
    ],
  }] });

  it('status says the AURA is behind Quest\'s release and exits 3', async () => {
    const f = await fixture([{ ...puck, installed: { versionCode: 14, versionName: '0.14.0-androidxr' } }]);
    await writeFile(join(f.dir, 'releases.json'), ledgerWith('d'.repeat(64), [{ platform: 'quest', to: 'meta:ALPHA', at }]));
    const result = await f.run(['status']);
    expect(result.code, result.stderr).toBe(3);
    expect(result.stdout).toMatch(/✓ Quest: 0\.15\.2 \(20\) went to meta:ALPHA/);
    expect(result.stdout).toMatch(/! Android XR: 0\.15\.2-androidxr \(20\) has gone nowhere yet/);
    expect(result.stdout).toMatch(/! Android XR Puck PUCK_USB \(Android XR\): 0\.14\.0-androidxr \(14\), 6 version code\(s\) behind/);
  });

  it('install records a release file it puts on a headset, and nothing else', async () => {
    const f = await fixture([puck]);
    const ledger = join(f.dir, 'releases.json');
    await writeFile(ledger, ledgerWith(await sha256File(f.apk)));
    const installed = await f.run(['install', '--platform', 'android-xr', '--apk', f.apk]);
    expect(installed.code, installed.stderr).toBe(0);
    expect(installed.stdout).toMatch(/recorded in app\/releases.json: 0\.15\.2 \(20\) is on this Android XR Puck/);
    const deliveries = JSON.parse(await readFile(ledger, 'utf8')).releases[0].deliveries;
    expect(deliveries).toEqual([{ platform: 'android-xr', to: 'adb:Android XR Puck', at: expect.any(String) }]);
    await writeFile(f.apk, 'a development build');
    const dev = await f.run(['install', '--platform', 'android-xr', '--apk', f.apk]);
    expect(dev.code, dev.stderr).toBe(0);
    expect(dev.stdout).not.toMatch(/recorded/);
    expect(JSON.parse(await readFile(ledger, 'utf8')).releases[0].deliveries).toHaveLength(1);
  });

  it('status asks the Vision Pro over devicectl, and says when none can be reached', async () => {
    const f = await fixture([], { vision: { device: 'Apple Vision Pro', model: 'RealityDevice14,1', os: '26.6', installed: true, version: '0.15.1', build: '19' } });
    await writeFile(join(f.dir, 'releases.json'), ledgerWith('d'.repeat(64)));
    const seen = await f.run(['status']);
    expect(seen.code, seen.stderr).toBe(3);
    expect(seen.stdout).toMatch(/! Vision Pro: 0\.15\.2 \(20\) has no Vision Pro build; it was released without one/);
    expect(seen.stdout).toMatch(/! Apple Vision Pro RealityDevice14,1 \(Vision Pro\): 0\.15\.1 \(19\), 1 version code\(s\) behind 0\.15\.2 \(20\)/);
    const none = await fixture([]);
    await writeFile(join(none.dir, 'releases.json'), ledgerWith('d'.repeat(64)));
    expect((await none.run(['status'])).stdout).toMatch(/no Vision Pro reachable over devicectl, so only the ledger was checked for it/);
  });

  it.skipIf(!existsSync('/usr/bin/ditto'))('install --platform visionos installs a release zip with devicectl and records it, and refuses anything else', async () => {
    const f = await fixture([], { vision: { device: 'Apple Vision Pro', model: 'RealityDevice14,1', os: '26.6', installed: true, version: '0.15.2', build: '20' } });
    const app = join(f.dir, 'Polydance.app');
    await mkdir(app);
    await writeFile(join(app, 'Info.plist'), 'synthetic');
    const zip = join(f.dir, 'polydance-visionos-release-0.15.2-20.zip');
    await exec('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]);
    const ledger = join(f.dir, 'releases.json');
    const entry = JSON.parse(ledgerWith('d'.repeat(64)));
    entry.releases[0].artifacts.push({ platform: 'visionos', variant: 'release', kind: 'app', file: basename(zip), sha256: await sha256File(zip) });
    await writeFile(ledger, JSON.stringify(entry));
    const installed = await f.run(['install', '--platform', 'visionos', '--app', zip]);
    expect(installed.code, installed.stderr).toBe(0);
    expect(installed.stdout).toMatch(/installed 0\.15\.2 \(20\) on Apple Vision Pro; recorded in app\/releases.json/);
    expect(JSON.parse(await readFile(ledger, 'utf8')).releases[0].deliveries).toEqual([{ platform: 'visionos', to: 'devicectl:RealityDevice14,1', at: expect.any(String) }]);
    expect((await f.calls()).some(c => c[0] === 'visionos' && c[1] === 'install' && c[2] === '--app')).toBe(true);
    await writeFile(zip, 'not a release');
    expect((await f.run(['install', '--platform', 'visionos', '--app', zip])).stderr).toMatch(/is not a Vision Pro release in app\/releases.json/);
    expect((await f.run(['install', '--platform', 'visionos', '--apk', f.apk])).stderr).toMatch(/the Vision Pro takes --app/);
  });

  it('upload refuses an APK that is not a recorded Quest release, before Meta is involved', async () => {
    const f = await fixture([quest]);
    await writeFile(join(f.dir, 'releases.json'), ledgerWith(await sha256File(f.apk)));
    const xrDebug = await f.run(['upload', '--apk', f.apk, '--channel', 'alpha'], { POLYCAP_OVR_PLATFORM_UTIL: join(f.dir, 'missing-tool') });
    expect(xrDebug.code).not.toBe(0);
    expect(xrDebug.stderr).toMatch(/is not a Quest release in app\/releases.json/);
    const play = await f.run(['upload', '--platform', 'android-xr', '--apk', f.apk, '--channel', 'internal']);
    expect(play.stderr).toMatch(/Android XR goes to Google Play/);
  });
});
