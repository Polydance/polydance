/**
 * Mac side of Polydance's headset app: build for Quest or Android XR, install, configure and pull its run
 * folders back and analyse them, and move its data across the 2026-10-02 rename. Developer tooling over
 * adb, not part of polycap; it reuses polycap's adb and exec wrappers so the same rules hold (no host
 * shell, verified pulls, private folders, nothing deleted on the headset).
 */
import { chmod, readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { z } from 'zod';
import { Adb, parseStatLines, shellQuote } from '../../src/adb.js';
import { UserError } from '../../src/errors.js';
import { exec, ToolError } from '../../src/exec.js';
import { exists, privateDir, sha256File, sleep, writeJsonAtomic } from '../../src/fsx.js';
import {
  DEFAULT_THRESHOLDS, endReason, formatRel, gaps, judge, parseBlackdetect, parseFreezedetect, parsePacketTimes, parseTimeline,
  recordingEndMs, windowReport, windows, type ProbeEvent, type VideoFacts,
} from './analysis.js';
import { chooseDevice, connectFailureHint, connectSucceeded, isNetworkSerial, parseLogsGrant, parseWifiIp, recordingInProgress } from './device.js';
import { ANDROID_DIR, assertPlatform, buildTarget, connectTarget, platformFor, PLATFORMS, type Platform } from './platform.js';
import { drift, parseInstalled, type HeadsetSeen } from './releases.js';
import { check, installVision, keystore, readLedger, recordInstall, release, RELEASE_APK, sourceVersion, upload, visionInstalled } from './store.js';

const PACKAGE = 'net.polydance.capture';
/** The app's id before it was renamed Polydance Capture (2026-10-02); `migrate` copies its data across. */
const OLD_PACKAGE = 'dev.headsetinbox.captureprobe';
const DEVICE_RUNS = `/sdcard/Android/data/${PACKAGE}/files/runs`;
const HERE = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_OUT = resolve(HERE, '../../.local/runs');
const RUN_NAME = /^\d{8}-\d{6}$/;
const ADB = process.env.POLYCAP_ADB || 'adb';
const FFMPEG = process.env.POLYCAP_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.POLYCAP_FFPROBE || 'ffprobe';

const USAGE = `app: developer tools for Polydance's headset app over adb

  npm run app -- build [--platform quest|android-xr] [--release]
        build with JDK 17 and the SDK at JAVA_HOME / ANDROID_HOME; debug is the default
  npm run app -- wifi [--platform quest|android-xr] [--device USB_SERIAL] [--port 5555]
        Quest: switch USB adb to Wi-Fi; Android XR: show standard adb pair/connect instructions
  npm run app -- install [--platform quest|android-xr] [--release] [--connect HOST:PORT] [--device SERIAL] [--apk PATH] [--launch] [--any-device] [--force]
        refuses a wrong/unknown headset unless explicitly selected with --any-device; refuses an
        active recording unless --force. Android XR --connect requires the device's connection port
  npm run app -- install --platform visionos [--app RELEASE.zip] [--device NAME] [--launch]
        the Vision Pro over devicectl (visionos/build.sh; docs/VISIONOS.md); a release's .zip is recorded
  npm run app -- configure --server URL --token-file FILE [--platform quest|android-xr] [--device SERIAL]
        give the app the receiver address and upload token (the private file holds only the token)
  npm run app -- logs [--platform quest|android-xr] [--device SERIAL] [--force]
        let a debug build read every app's log for a take (READ_LOGS, granted over adb; docs/LOGS.md), and say
        whether the headset has it. Android restarts Polydance to apply it, so a take in progress is refused unless --force
  npm run app -- migrate [--platform quest|android-xr] [--device SERIAL]
        copy the recordings, upload state and settings from ${OLD_PACKAGE}; nothing is deleted
  npm run app -- pull [--platform quest|android-xr] [--device SERIAL] [--out DIR]
        copy run folders, verified by size and sha256; nothing is deleted on the headset
  npm run app -- analyze [RUN|latest|DIR] [--out DIR] [--json]
        answer yes / no / inconclusive for one run and save analysis.json and away frames

Platform defaults to quest. Both flavors use ${PACKAGE}; installing one replaces the other.

Releases, one for every headset (docs/RELEASING.md, private/docs/STORE.md, private/docs/PLAY.md):
  npm run app -- keystore
        make the upload key once, in ~/.config/polycap/android (back it up)
  npm run app -- release [--skip-visionos]
        from main's committed tip only: build every flavor from clean and the Vision Pro's app, check each against
        its platform's rules and the others, keep copies in .local/store and record the release in app/releases.json.
        --skip-visionos releases Quest and Android XR without the Vision Pro, which status then shows as behind
  npm run app -- status [--json]
        what the source, each platform's channels and each connected headset have; exits 3 if anything is behind
  npm run app -- check [--platform quest|android-xr] [--apk PATH]
        check an APK against its platform's rules (signing, manifest, permissions, native code, size)
  npm run app -- upload --platform quest --apk PATH --channel alpha [--notes TEXT] [--draft]
        a recorded Quest release only: check it, upload it to a Meta release channel with ovr-platform-util
        and ~/.config/polycap/meta-upload-token, and record the delivery

Runs land in ${DEFAULT_OUT} (gitignored, owner-only).`;

const print = (line = '') => console.log(line);

async function device(adb: Adb, explicit: string | undefined, platform: Platform, want: 'any' | 'usb' = 'any', anyDevice = false) {
  const devices = await adb.devices();
  // Some engineering builds omit or abbreviate the adb model. Properties may identify AURA, but
  // an unrecognized model never becomes a match just because its manufacturer is XREAL or Meta.
  for (const d of devices) {
    if (d.state !== 'device' || (explicit && d.serial !== explicit) || platform.matchesModel(d.model ?? '')) continue;
    const p = await adb.getprops(d.serial, ['ro.product.model', 'ro.product.manufacturer']);
    const model = p['ro.product.model'], manufacturer = p['ro.product.manufacturer'];
    if (platform.matchesModel(model, manufacturer)) d.model = platform.matchesModel(model) ? model : `${manufacturer} ${model}`;
  }
  const candidates = devices.filter(d => d.state === 'device' && platform.matchesModel(d.model ?? '') && (want === 'any' || !isNetworkSerial(d.serial)));
  const hardware = new Map<string, string>();
  if (!explicit && candidates.length > 1) {
    for (const d of candidates) hardware.set(d.serial, (await adb.shell(d.serial, 'getprop ro.serialno', 15_000)).trim());
  }
  return chooseDevice(devices, explicit, want, hardware, platform, anyDevice);
}

/** Build through the wrapper directly: no host shell, guessed SDK locations or dependency setup. */
async function build(platform: Platform, release: boolean) {
  const env = z.object({ JAVA_HOME: z.string().trim().min(1), ANDROID_HOME: z.string().trim().min(1) }).safeParse(process.env);
  if (!env.success) throw new UserError('build needs JAVA_HOME pointing to JDK 17 and ANDROID_HOME pointing to an installed Android SDK; set both environment variables and try again');
  const { JAVA_HOME, ANDROID_HOME } = env.data;
  if (!(await stat(ANDROID_HOME).catch(() => undefined))?.isDirectory()) throw new UserError(`ANDROID_HOME is not an SDK directory: ${ANDROID_HOME}`);
  let version: string;
  try {
    const result = await exec(join(JAVA_HOME, 'bin/java'), ['-version'], { timeoutMs: 15_000 });
    version = result.stderr + result.stdout;
  } catch { throw new UserError('cannot run JAVA_HOME/bin/java; set JAVA_HOME to an installed JDK 17'); }
  if (!/version\s+"17(?:[."+\-])/.test(version)) throw new UserError('build requires JDK 17; set JAVA_HOME to a JDK 17 installation');
  const target = buildTarget(platform, release);
  print(`Building ${platform.label}: ${target.task}…`);
  try {
    const result = await exec(join(ANDROID_DIR, 'gradlew'), [...(release ? ['clean'] : []), target.task], {
      cwd: ANDROID_DIR, timeoutMs: 30 * 60_000, env: { ...process.env, JAVA_HOME, ANDROID_HOME },
    });
    print(result.stdout.trim());
    if (result.stderr.trim()) console.error(result.stderr.trim());
  } catch (error) {
    throw new UserError(`Build failed. Check JDK 17, ANDROID_HOME, installed SDK components and the Gradle wrapper. ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!await exists(target.apk)) throw new UserError(`Gradle finished but no APK was found at ${target.apk}`);
  print(`APK: ${target.apk}`);
}

/** Polls until adb lists the target as ready; an unauthorised headset gets one prompt to accept. */
async function waitUntilReady(adb: Adb, target: string, timeoutMs = 120_000): Promise<void> {
  let told = false;
  for (const started = Date.now(); Date.now() - started < timeoutMs; await sleep(2000)) {
    const state = (await adb.devices()).find(d => d.serial === target)?.state;
    if (state === 'device') return;
    if (state === 'unauthorized' && !told) {
      print('The headset is asking to allow debugging from this Mac: accept it in the headset, and tick "Always allow from this computer".');
      told = true;
    }
    if (state === undefined) await exec(ADB, ['connect', target], { timeoutMs: 15_000, allowFailure: true }).catch(() => undefined);
  }
  throw new UserError(`${target} did not become ready within ${timeoutMs / 1000} s; is the prompt still waiting in the headset?`);
}

async function props(adb: Adb, serial: string) {
  return adb.getprops(serial, ['ro.product.manufacturer', 'ro.product.model', 'ro.build.version.release', 'ro.build.version.sdk', 'ro.build.display.id']);
}

async function wifi(opts: { device?: string; port: number; platform: Platform }) {
  if (opts.platform.legacyWifiPort === undefined) { print(opts.platform.wifiHelp); return; }
  const adb = new Adb(ADB);
  const usb = await device(adb, opts.device, opts.platform, 'usb');
  const ip = parseWifiIp(await adb.shell(usb.serial, 'ip route'));
  if (!ip) throw new UserError(`${usb.serial} reported no Wi-Fi address; is the headset on Wi-Fi?`);
  await exec(ADB, ['-s', usb.serial, 'tcpip', String(opts.port)], { timeoutMs: 30_000 });
  await sleep(2000); // adbd restarts in TCP mode; connecting at once usually fails.
  const target = `${ip}:${opts.port}`;
  // adbd restarts in TCP mode, which can drop the authorisation; `adb connect` then waits on the
  // headset's prompt instead of returning, so a timeout here is not a failure on its own.
  const connect = await exec(ADB, ['connect', target], { timeoutMs: 15_000, allowFailure: true }).catch(() => ({ stdout: '' }));
  if (/failed|cannot|unable/i.test(connect.stdout) && !connectSucceeded(connect.stdout)) {
    throw new UserError(`adb connect ${target} failed: ${connect.stdout.trim()}. ${connectFailureHint(connect.stdout, opts.platform)}`);
  }
  await waitUntilReady(adb, target);
  print(`Connected to ${target}. You can unplug the cable.`);
  print(`Next: npm run app -- install --platform ${opts.platform.id} --device ${target} --launch`);
  print('Wi-Fi adb lasts until the headset reboots; run this again after a restart.');
}

async function install(opts: { connect?: string; device?: string; apk: string; launch: boolean; anyDevice: boolean; force: boolean; platform: Platform; release: boolean }) {
  const adb = new Adb(ADB);
  let explicit = opts.device;
  if (opts.connect) {
    if (opts.device) throw new UserError('use either --connect or --device, not both');
    const target = connectTarget(opts.connect, opts.platform);
    const { stdout } = await exec(ADB, ['connect', target], { timeoutMs: 15_000, allowFailure: true }).catch(() => ({ stdout: '' }));
    if (/failed|cannot|unable/i.test(stdout) && !connectSucceeded(stdout)) {
      throw new UserError(`adb connect ${target} failed: ${stdout.trim()}\n${connectFailureHint(stdout, opts.platform)}`);
    }
    await waitUntilReady(adb, target);
    explicit = target;
  }
  if (!await exists(opts.apk)) {
    throw new UserError(`no APK at ${opts.apk}; build it: npm run app -- build --platform ${opts.platform.id}${opts.release ? ' --release' : ''} (JDK 17)`);
  }
  const target = await device(adb, explicit, opts.platform, 'any', opts.anyDevice);
  const p = await props(adb, target.serial);
  print(`${target.serial}: ${p['ro.product.manufacturer']} ${p['ro.product.model']}, Android ${p['ro.build.version.release']} (SDK ${p['ro.build.version.sdk']}), build ${p['ro.build.display.id']}`);
  assertPlatform(opts.platform, target.serial, p['ro.product.model'], p['ro.product.manufacturer'], opts.anyDevice);
  const services = await adb.shell(target.serial, `dumpsys activity services ${PACKAGE}/.RecorderService`).catch(() => '');
  const newest = (await adb.shell(target.serial, `stat -c '%Y' ${shellQuote(DEVICE_RUNS)}/*/video.mp4 2>/dev/null; true`))
    .split('\n').map(Number).filter(n => Number.isFinite(n) && n > 0).sort((a, b) => b - a)[0];
  const now = Number((await adb.shell(target.serial, 'date +%s')).trim());
  if (recordingInProgress(services, newest, now) && !opts.force) {
    throw new UserError('Polydance is recording right now. Installing kills the app and the recording would be lost (it has no index until Stop). Stop it in the headset first, or pass --force.');
  }
  print(`installing over ${isNetworkSerial(target.serial) ? 'Wi-Fi' : 'USB'}…`);
  const installed = await exec(ADB, ['-s', target.serial, 'install', '-r', opts.apk], { timeoutMs: 10 * 60_000, allowFailure: true });
  if (installed.code !== 0) {
    const said = `${installed.stdout}\n${installed.stderr}`;
    // Since the store build (2026-10-08) builds are signed with the upload key; one signed with the debug key is a different app to Android.
    if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(said)) {
      throw new UserError(`the headset has a build of ${PACKAGE} signed with a different key (the debug key, before the store build). Uninstalling it deletes its recordings, so first: npm run app -- pull. Then uninstall it in the headset, or adb uninstall ${PACKAGE}, and install again (private/docs/STORE.md).`);
    }
    throw new UserError(`adb install failed: ${said.trim().split('\n').slice(-3).join(' ')}`);
  }
  print(`installed ${PACKAGE} (${opts.platform.label}). ${opts.platform.installedHint}`);
  // A release's own file (npm run app -- release) is a delivery `status` should know about; a fresh build is not.
  const recorded = await recordInstall(opts.apk, p['ro.product.model'] || opts.platform.label);
  if (recorded) print(`recorded in app/releases.json: ${recorded} is on this ${p['ro.product.model'] || 'headset'}; commit it.`);
  if (opts.launch) {
    await adb.shell(target.serial, `am start -n ${PACKAGE}/.MainActivity`);
    print('launched; put the headset on to press Start and accept the capture dialog.');
  }
}

/**
 * Is any headset behind? The source, the release ledger and every connected headset, against the newest
 * release (releases.ts). Exit 3 when something is behind, so a script or an agent can stop on it.
 */
async function status(opts: { json: boolean }): Promise<number> {
  const ledger = await readLedger();
  const source = await sourceVersion().catch(() => undefined);
  const adb = new Adb(ADB);
  const devices = (await adb.devices().catch(() => [])).filter(d => d.state === 'device');
  const headsets: HeadsetSeen[] = [];
  for (const d of devices) {
    const p = await adb.getprops(d.serial, ['ro.product.model', 'ro.product.manufacturer']);
    const platform = Object.values(PLATFORMS).find(x => x.matchesModel(p['ro.product.model'], p['ro.product.manufacturer']))?.id;
    const installed = parseInstalled(await adb.shell(d.serial, `dumpsys package ${PACKAGE}`).catch(() => ''));
    headsets.push({ label: `${p['ro.product.model'] || d.model || 'device'} ${d.serial}`, platform, installed });
  }
  // The Vision Pro answers devicectl, not adb (visionos/build.sh installed); unreachable, only the ledger speaks for it.
  const vision = await visionInstalled();
  if (vision) {
    headsets.push({ label: `${vision.device} ${vision.model}`, platform: 'visionos',
      installed: vision.installed && vision.version && vision.build ? { versionCode: Number(vision.build), versionName: vision.version } : undefined });
  }
  const findings = drift({ ledger, source, headsets });
  if (opts.json) print(JSON.stringify(findings, null, 2));
  else {
    for (const f of findings) print(`${{ ok: '✓', note: '·', behind: '!' }[f.level]} ${f.text}`);
    if (!devices.length) print('· no headset connected over adb, so only the ledger was checked');
    if (!vision) print('· no Vision Pro reachable over devicectl, so only the ledger was checked for it');
  }
  return findings.some(f => f.level === 'behind') ? 3 : 0;
}

/**
 * Sends the receiver address and upload token to the app over adb. The token is read from a private
 * file, never argv, so it stays out of shell history; it crosses adb once and is not logged by the app.
 */
async function configure(opts: { server: string; tokenFile: string; device?: string; platform: Platform }) {
  const info = await stat(opts.tokenFile).catch(() => { throw new UserError(`no token file at ${opts.tokenFile}`); });
  if (info.mode & 0o077) throw new UserError(`${opts.tokenFile} is readable by others; chmod 600 it`);
  const token = (await readFile(opts.tokenFile, 'utf8')).trim();
  // Tokens made before the rename start hib_ and keep working.
  if (!/^(polycap|hib)_[0-9a-f]{64}$/.test(token)) throw new UserError(`${opts.tokenFile} does not hold a polycap_ (or older hib_) token`);
  const server = opts.server.replace(/\/+$/, '');
  if (!/^https:\/\/|^http:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(server)) throw new UserError('--server must be https, or http on the local network');
  const adb = new Adb(ADB);
  const target = await device(adb, opts.device, opts.platform);
  try {
    await adb.shell(target.serial, `am start -n ${PACKAGE}/.MainActivity -a ${PACKAGE}.CONFIGURE --es server ${shellQuote(server)} --es token ${shellQuote(token)}`);
  } catch {
    // Android/adb errors can echo the entire intent, including its token. Never print that output.
    throw new UserError(`could not configure ${target.serial}; check that the app is installed and adb is authorized (device output withheld to protect the token)`);
  }
  print(`sent ${server} and the upload token to ${target.serial}; the app shows "Server: ${server}" when it took them.`);
}

/**
 * Lets Polydance keep every app's log in a take (docs/LOGS.md): grants READ_LOGS, a development permission that only
 * adb can give, then reads back whether the headset has it. Only debug builds declare it (Meta's store prohibits it).
 * Android ends the app's process when a grant changes its groups, which would cut off a recording, so one in progress
 * is refused unless --force; a take of logs alone comes back by itself (LogsTake). The grant is not the whole story:
 * Android 13+ still asks in the headset each time a take's logs are read, and only while Polydance is in front.
 */
async function logs(opts: { device?: string; platform: Platform; force: boolean }) {
  const adb = new Adb(ADB);
  const target = await device(adb, opts.device, opts.platform);
  const read = async () => parseLogsGrant(await adb.shell(target.serial, `dumpsys package ${PACKAGE}`).catch(() => ''), PACKAGE);
  const before = await read();
  if (!before.installed) throw new UserError(`Polydance is not installed on ${target.serial}: npm run app -- install --platform ${opts.platform.id}`);
  if (!before.declared) {
    throw new UserError(`the Polydance on ${target.serial} does not ask for READ_LOGS: only debug builds do, since Meta's store prohibits it. ` +
      `Install one (npm run app -- install --platform ${opts.platform.id}) and run this again; without it a take keeps Polydance's own lines.`);
  }
  if (before.granted) { print(`${target.serial}: READ_LOGS is already granted. Each take's logs include other apps' when you allow the headset's prompt.`); return; }
  const services = await adb.shell(target.serial, `dumpsys activity services ${PACKAGE}/.RecorderService`).catch(() => '');
  if (!opts.force && recordingInProgress(services, undefined, 0)) {
    throw new UserError('Polydance is recording, and the grant restarts it, which would cut the recording off. Stop it on the deck first, or pass --force.');
  }
  const grant = await exec(ADB, ['-s', target.serial, 'shell', 'pm', 'grant', PACKAGE, 'android.permission.READ_LOGS'], { timeoutMs: 30_000, allowFailure: true });
  const after = await read();
  if (!after.granted) {
    throw new UserError(`the headset did not grant READ_LOGS${grant.code ? ` (pm grant exited ${grant.code}: ${(grant.stderr || grant.stdout).trim().slice(0, 300)})` : ''}`);
  }
  print(`${target.serial}: READ_LOGS granted, and the headset says so. Android restarts Polydance to apply it.`);
  print('When a take with Logs on stops on the deck, the headset asks to let Polydance access all device logs: allow it to include other apps\' lines.');
}

/**
 * Copies the old app's data into the renamed one on the headset. A new app id is a separate app to
 * Android: without this it would start with an empty rack and a new device id, and the receiver knows
 * this headset's uploads by the old one. Recordings (with their upload.json) are in each app's external
 * files folder, which adb can read and write; settings are private, so `run-as` moves them, which works
 * because both are debug builds. Existing recordings in the new app are kept, and nothing is deleted:
 * the old app keeps its copy until it is uninstalled by hand.
 */
async function migrate(opts: { device?: string; platform: Platform }) {
  const adb = new Adb(ADB);
  const target = await device(adb, opts.device, opts.platform);
  const sh = (command: string, timeoutMs?: number) => adb.shell(target.serial, command, timeoutMs);
  const installed = async (pkg: string) => (await sh(`pm path ${pkg}`).catch(() => '')).includes('package:');
  if (!await installed(OLD_PACKAGE)) { print(`${OLD_PACKAGE} is not installed on ${target.serial}; nothing to copy.`); return; }
  if (!await installed(PACKAGE)) throw new UserError(`install the renamed app first: npm run app -- install --platform ${opts.platform.id}`);
  for (const pkg of [OLD_PACKAGE, PACKAGE]) {
    if (recordingInProgress(await sh(`dumpsys activity services ${pkg}/.RecorderService`).catch(() => ''), undefined, 0)) {
      throw new UserError(`${pkg} is recording; stop it in the headset first`);
    }
  }
  const from = `/sdcard/Android/data/${OLD_PACKAGE}/files/runs`;
  const to = `/sdcard/Android/data/${PACKAGE}/files/runs`;
  const runs = (await sh(`ls -1 ${shellQuote(from)} 2>/dev/null; true`)).split('\n').map(r => r.trim()).filter(r => RUN_NAME.test(r));
  const needKb = Number((await sh(`du -sk ${shellQuote(from)} 2>/dev/null | cut -f1; true`)).trim()) || 0;
  const freeKb = Number((await sh(`df -k /sdcard | tail -1`)).trim().split(/\s+/)[3]) || 0;
  if (freeKb && needKb > freeKb - 1_048_576) throw new UserError(`copying needs ${Math.round(needKb / 1024)} MB and only ${Math.round(freeKb / 1024)} MB is free`);
  // Android creates an app's external folder when the app first asks for it, so a never-opened new app
  // is opened once rather than having adb create the folder with the wrong owner.
  if ((await sh(`[ -d /sdcard/Android/data/${PACKAGE}/files ] && echo yes; true`)).trim() !== 'yes') {
    await sh(`am start -n ${PACKAGE}/.MainActivity`);
    await sleep(4000);
  }
  // Neither app may rewrite its settings from memory while they are copied.
  await sh(`am force-stop ${OLD_PACKAGE}; am force-stop ${PACKAGE}`);
  await sh(`mkdir -p ${shellQuote(to)}`);
  let copied = 0, kept = 0;
  for (const run of runs) {
    if ((await sh(`[ -e ${shellQuote(`${to}/${run}`)} ] && echo yes; true`)).trim() === 'yes') { kept++; continue; }
    await sh(`cp -r ${shellQuote(`${from}/${run}`)} ${shellQuote(`${to}/${run}`)}`, 30 * 60_000);
    const size = async (dir: string) => (await sh(`stat -c %s ${shellQuote(`${dir}/${run}/video.mp4`)} 2>/dev/null; true`)).trim();
    if (await size(from) !== await size(to)) throw new UserError(`${run} did not copy completely; nothing was removed, run migrate again`);
    copied++;
  }
  const prefs = (await sh(`run-as ${OLD_PACKAGE} ls shared_prefs 2>/dev/null; true`)).split('\n').map(f => f.trim())
    .filter(f => /^[A-Za-z0-9._-]+\.xml$/.test(f) && !f.startsWith('androidx.'));
  for (const file of prefs) {
    await sh(`run-as ${OLD_PACKAGE} cat ${shellQuote(`shared_prefs/${file}`)} | run-as ${PACKAGE} sh -c ${shellQuote(`mkdir -p shared_prefs && cat > shared_prefs/${file}`)}`);
  }
  print(`copied ${copied} recording(s)${kept ? `, kept ${kept} the new app already had` : ''}, and settings ${prefs.join(', ') || '(none)'} into ${PACKAGE}.`);
  print(`${OLD_PACKAGE} is untouched; uninstall it in the headset (Settings > Apps) once the new rack shows everything.`);
}

async function pull(opts: { device?: string; out: string; platform: Platform }) {
  const adb = new Adb(ADB);
  const target = await device(adb, opts.device, opts.platform);
  const listing = await adb.shell(target.serial, `ls -1 ${shellQuote(DEVICE_RUNS)} 2>/dev/null; true`);
  const runs = listing.split('\n').map(s => s.trim()).filter(s => RUN_NAME.test(s));
  if (!runs.length) { print(`no runs on ${target.serial} under ${DEVICE_RUNS}`); return; }
  const deviceNow = Number((await adb.shell(target.serial, 'date +%s')).trim()) * 1000;
  await privateDir(opts.out);
  for (const run of runs) {
    const files = parseStatLines(await adb.shell(target.serial, `stat -c '%s %Y %n' ${shellQuote(`${DEVICE_RUNS}/${run}`)}/* 2>/dev/null; true`));
    const finished = files.some(f => f.name === 'summary.json');
    if (!finished && files.some(f => deviceNow - f.mtimeMs < 60_000)) {
      print(`${run}: skipped, still being written (stop the recording first)`);
      continue;
    }
    const dir = join(opts.out, run);
    await privateDir(dir);
    let pulled = 0, kept = 0;
    for (const file of files) {
      const local = join(dir, file.name);
      const deviceSha = await adb.sha256(target.serial, file.path);
      if (await exists(local) && (await stat(local)).size === file.bytes && await sha256File(local) === deviceSha) { kept++; continue; }
      await adb.pull(target.serial, file.path, local);
      const size = (await stat(local)).size;
      if (size !== file.bytes || await sha256File(local) !== deviceSha) throw new Error(`${file.path} did not arrive intact (${size} of ${file.bytes} bytes or a different sha256)`);
      await chmod(local, 0o600);
      pulled++;
    }
    print(`${run}: ${pulled} pulled, ${kept} already here${finished ? '' : '; no summary.json, so the app was killed before it stopped'}`);
  }
  print(`next: npm run app -- analyze latest`);
}

async function resolveRun(target: string, out: string): Promise<string> {
  if (target === 'latest') {
    const names = (await readdir(out).catch(() => [] as string[])).filter(n => RUN_NAME.test(n)).sort();
    if (!names.length) throw new UserError(`no runs in ${out}; npm run app -- pull first`);
    return join(out, names[names.length - 1]);
  }
  for (const dir of [resolve(target), join(out, target)]) if (await exists(join(dir, 'timeline.jsonl'))) return dir;
  throw new UserError(`${target} is not a run folder (no timeline.jsonl)`);
}

const ffprobeSchema = z.object({
  streams: z.array(z.looseObject({ codec_type: z.string().optional(), codec_name: z.string().optional(), width: z.number().optional(), height: z.number().optional(), channels: z.number().optional() })).default([]),
  format: z.looseObject({ duration: z.string().optional(), start_time: z.string().optional() }),
});

async function videoFacts(file: string) {
  const { stdout } = await exec(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const info = ffprobeSchema.parse(JSON.parse(stdout));
  const start = Number(info.format.start_time ?? 0) || 0;
  const durationMs = Math.round((Number(info.format.duration) || 0) * 1000);
  const video = info.streams.find(s => s.codec_type === 'video');
  const packets = await exec(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file], { timeoutMs: 10 * 60_000 });
  const ptsMs = parsePacketTimes(packets.stdout, start);
  // ffmpeg normalises its own clock to start at 0, as ptsMs now does; a small picture is plenty to judge.
  const detect = await exec(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-an', '-vf', 'scale=320:-2,blackdetect=d=0.5:pix_th=0.10,freezedetect=n=-50dB:d=2', '-f', 'null', '-'], { timeoutMs: 30 * 60_000 });
  const facts: VideoFacts = { durationMs, ptsMs, black: parseBlackdetect(detect.stderr), frozen: parseFreezedetect(detect.stderr, durationMs) };
  const audio = [];
  for (const [i, stream] of info.streams.filter(s => s.codec_type === 'audio').entries()) {
    const level = await exec(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-map', `0:a:${i}`, '-af', 'volumedetect', '-f', 'null', '-'], { timeoutMs: 10 * 60_000 });
    const db = (name: string) => Number(level.stderr.match(new RegExp(`${name}: (-?[\\d.]+) dB`))?.[1] ?? NaN);
    audio.push({ index: i, channels: stream.channels, meanDb: db('mean_volume'), maxDb: db('max_volume') });
  }
  return { facts, width: video?.width, height: video?.height, codec: video?.codec_name, audio };
}

const runSchema = z.looseObject({
  config: z.looseObject({ width: z.number(), height: z.number(), mic: z.boolean(), appAudio: z.boolean().optional(), engine: z.string().optional(), audioTracks: z.array(z.string()).optional() }),
  device: z.looseObject({ manufacturer: z.string(), model: z.string(), release: z.string(), sdk: z.number(), display: z.string().optional() }),
});

/** Events worth a line in the report: anything the system did to the capture, not routine lifecycle. */
const NOTABLE: Record<string, string[]> = {
  projection: ['stop', 'content_resize', 'content_visible'], display: ['paused', 'resumed', 'stopped'],
  recorder: ['info', 'error', 'stop_failed'], system: ['screen'],
  service: ['task_removed', 'trim_memory', 'destroy', 'foreground_failed', 'projection_null', 'projection_failed', 'recorder_setup_failed', 'run_dir_failed', 'finishing'],
  probe: ['consent_result', 'mic_disabled', 'permission_result'],
  capture: ['prepared', 'audio_open', 'audio_unavailable', 'video_clock', 'muxer_started', 'track_failed', 'audio_idle', 'audio_resumed', 'audio_track_end', 'video_eos_timeout', 'audio_eos_timeout', 'samples_dropped_before_start'],
};
const describeEvent = (e: ProbeEvent) => {
  const { t: _t, up: _up, rel: _rel, src, ev, ...rest } = e;
  const detail = Object.entries(rest).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' ');
  return `${e.rel === null ? 'before start' : formatRel(e.rel)}  ${src} ${ev} ${detail}`.trimEnd();
};

async function analyze(opts: { target: string; out: string; json: boolean }) {
  const dir = await resolveRun(opts.target, opts.out);
  const events = parseTimeline(await readFile(join(dir, 'timeline.jsonl'), 'utf8'));
  const run = await exists(join(dir, 'run.json')) ? runSchema.parse(JSON.parse(await readFile(join(dir, 'run.json'), 'utf8'))) : undefined;
  let media: Awaited<ReturnType<typeof videoFacts>> | undefined, videoError: string | undefined;
  try { media = await videoFacts(join(dir, 'video.mp4')); }
  catch (error) { videoError = error instanceof ToolError ? error.message.split('\n').pop() : String(error); }
  const facts: VideoFacts = media?.facts ?? { durationMs: 0, ptsMs: [], black: [], frozen: [] };

  const hidden = windows(events, 'hidden').map(w => windowReport(w, events, facts));
  const unfocused = windows(events, 'unfocused').map(w => windowReport(w, events, facts));
  const recordingMs = recordingEndMs(events);
  const reason = endReason(events);
  const verdict = judge({ reason, recordingMs, video: facts, videoError, hidden, mic: run?.config.mic ?? false, app: run?.config.appAudio ?? false });

  const frames: string[] = [];
  if (media) {
    for (const [i, w] of hidden.entries()) {
      if (w.endMs - w.startMs < DEFAULT_THRESHOLDS.minAwayMs) continue;
      const name = `away-${i + 1}.jpg`;
      await exec(FFMPEG, ['-y', '-v', 'error', '-ss', ((w.startMs + w.endMs) / 2000).toFixed(3), '-i', join(dir, 'video.mp4'), '-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '3', join(dir, name)]);
      await chmod(join(dir, name), 0o600).catch(() => undefined);
      frames.push(name);
    }
  }
  const allGaps = gaps(facts.ptsMs, 500);
  const notable = events.filter(e => NOTABLE[e.src]?.includes(e.ev));
  const analysis = {
    run: dir.split('/').pop(), device: run?.device, config: run?.config, verdict, recordingMs, endReason: reason,
    video: media ? { durationMs: facts.durationMs, frames: facts.ptsMs.length, width: media.width, height: media.height, codec: media.codec, audio: media.audio.map(a => ({ ...a, name: run?.config.audioTracks?.[a.index] ?? (a.index === 0 && run?.config.mic ? 'mic' : undefined) })), gapsOver500ms: allGaps, black: facts.black, frozen: facts.frozen } : { error: videoError },
    hidden, unfocused, frames, notable,
  };
  await writeJsonAtomic(join(dir, 'analysis.json'), analysis);
  if (opts.json) { print(JSON.stringify(analysis, null, 2)); return verdict.answer; }

  const d = run?.device;
  print(`Run ${analysis.run}${d ? ` · ${d.manufacturer} ${d.model} · Android ${d.release} (SDK ${d.sdk}) · ${d.display ?? ''}` : ''}`);
  if (run) print(`Capture ${run.config.width}×${run.config.height}, mic ${run.config.mic ? 'on' : 'off'}, in-app audio ${run.config.appAudio ? 'on' : 'off'}, engine ${run.config.engine ?? 'mediarecorder'}`);
  print();
  print(`Answer: ${verdict.answer.toUpperCase()}`);
  for (const r of verdict.reasons) print(`  - ${r}`);
  for (const w of verdict.warnings) print(`  ! ${w}`);
  print();
  print(`Recording ran ${formatRel(recordingMs)}, ended by ${reason ?? 'nothing recorded (killed?)'}`);
  if (media) {
    const fps = facts.durationMs ? facts.ptsMs.length / (facts.durationMs / 1000) : 0;
    const longest = allGaps.reduce((m, g) => (g.ms > m.ms ? g : m), { startMs: 0, endMs: 0, ms: 0 });
    print(`Video ${formatRel(facts.durationMs)}, ${facts.ptsMs.length} frames, ${fps.toFixed(1)} fps average, ${media.width}×${media.height} ${media.codec}`);
    // Track names come from run.json: MediaMuxer cannot label MP4 tracks itself.
    const names = run?.config.audioTracks ?? (run?.config.mic ? ['mic'] : []);
    print(media.audio.length
      ? `Audio: ${media.audio.map(a => `track ${a.index + 1} ${names[a.index] ?? '?'} (${a.channels ?? '?'} ch, mean ${a.meanDb.toFixed(1)} dB, max ${a.maxDb.toFixed(1)} dB)`).join('; ')}`
      : 'Audio: none');
    print(`  ${allGaps.length} gaps over 0.5 s${longest.ms ? `, longest ${(longest.ms / 1000).toFixed(1)} s at ${formatRel(longest.startMs)}` : ''}`);
  } else {
    print(`Video unreadable: ${videoError}`);
  }
  print();
  print(hidden.length ? 'Away (probe hidden, another app in front):' : 'Never away: the probe stayed visible for the whole run.');
  for (const [i, w] of hidden.entries()) {
    print(`  #${i + 1} ${formatRel(w.startMs)}–${formatRel(w.endMs)} (${((w.endMs - w.startMs) / 1000).toFixed(1)} s${w.open ? ', never came back' : ''}): ` +
      `${w.frames} frames (${w.fps.toFixed(1)} fps), longest silence ${(w.longestSilence.ms / 1000).toFixed(1)} s, ` +
      `black ${(w.blackFraction * 100).toFixed(0)}%, frozen ${(w.frozenFraction * 100).toFixed(0)}%, ` +
      `${w.heartbeats} heartbeats (max ${(w.maxHeartbeatIntervalMs / 1000).toFixed(1)} s apart), mic peak ${w.micPeak ?? 'off'}, app audio peak ${w.appPeak ?? 'off'}` +
      `${w.framesAfterReturn === null ? '' : `, ${w.framesAfterReturn} frames in the 3 s after`}`);
  }
  const brief = unfocused.filter(u => !hidden.some(h => u.startMs <= h.startMs && u.endMs >= h.endMs));
  if (brief.length) print(`Unfocused but visible: ${brief.length} period(s), longest ${(Math.max(...brief.map(u => u.endMs - u.startMs)) / 1000).toFixed(1)} s`);
  if (notable.length) { print(); print('Events:'); for (const e of notable) print(`  ${describeEvent(e)}`); }
  print();
  if (frames.length) print(`Look at the frame from the middle of each away period: ${frames.map(f => join(dir, f)).join(', ')}`);
  print(`Saved ${join(dir, 'analysis.json')}. Every frame: polycap import ${join(dir, 'video.mp4')} --app ${PACKAGE}`);
  return verdict.answer;
}

async function main(argv: string[]): Promise<number> {
  const [command = 'help', ...rest] = argv;
  if (['help', '--help', '-h'].includes(command)) { print(USAGE); return 0; }
  const parse = <T extends ParseArgsOptionsConfig>(options: T) => {
    try { return parseArgs({ args: rest, options, allowPositionals: true, strict: true }); }
    catch (error) { throw new UserError(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`); }
  };
  const platformOption = { platform: { type: 'string' as const, default: 'quest' } };
  switch (command) {
    case 'build': {
      const { values } = parse({ ...platformOption, release: { type: 'boolean' } });
      await build(platformFor(values.platform), Boolean(values.release));
      return 0;
    }
    case 'wifi': {
      const { values } = parse({ ...platformOption, device: { type: 'string' }, port: { type: 'string', default: '5555' } });
      const port = Number(values.port);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new UserError(`--port ${values.port} is not a port between 1024 and 65535`);
      await wifi({ device: values.device as string | undefined, port, platform: platformFor(values.platform) });
      return 0;
    }
    case 'install': {
      const { values } = parse({ ...platformOption, release: { type: 'boolean' }, connect: { type: 'string' }, device: { type: 'string' }, apk: { type: 'string' }, app: { type: 'string' }, launch: { type: 'boolean' }, 'any-device': { type: 'boolean' }, force: { type: 'boolean' } });
      if (values.platform === 'visionos') {
        if (values.apk || values.connect || values['any-device'] || values.force || values.release) throw new UserError('the Vision Pro takes --app (a release\'s .zip), --device and --launch');
        await installVision(print, { app: values.app ? resolve(values.app as string) : undefined, device: values.device as string | undefined, launch: Boolean(values.launch) });
        return 0;
      }
      if (values.app) throw new UserError('--app is the Vision Pro\'s; Quest and Android XR take --apk');
      const platform = platformFor(values.platform);
      await install({
        platform, release: Boolean(values.release),
        connect: values.connect as string | undefined, device: values.device as string | undefined,
        apk: resolve((values.apk as string | undefined) ?? buildTarget(platform, Boolean(values.release)).apk), launch: Boolean(values.launch), anyDevice: Boolean(values['any-device']), force: Boolean(values.force),
      });
      return 0;
    }
    case 'configure': {
      const { values } = parse({ ...platformOption, server: { type: 'string' }, 'token-file': { type: 'string' }, device: { type: 'string' } });
      if (!values.server || !values['token-file']) throw new UserError('configure needs --server and --token-file');
      await configure({ platform: platformFor(values.platform), server: values.server as string, tokenFile: resolve(values['token-file'] as string), device: values.device as string | undefined });
      return 0;
    }
    case 'logs': {
      const { values } = parse({ ...platformOption, device: { type: 'string' }, force: { type: 'boolean' } });
      await logs({ platform: platformFor(values.platform), device: values.device as string | undefined, force: Boolean(values.force) });
      return 0;
    }
    case 'migrate': {
      const { values } = parse({ ...platformOption, device: { type: 'string' } });
      await migrate({ platform: platformFor(values.platform), device: values.device as string | undefined });
      return 0;
    }
    case 'pull': {
      const { values } = parse({ ...platformOption, device: { type: 'string' }, out: { type: 'string' } });
      await pull({ platform: platformFor(values.platform), device: values.device as string | undefined, out: resolve((values.out as string | undefined) ?? DEFAULT_OUT) });
      return 0;
    }
    case 'keystore': {
      parse({});
      await keystore(print);
      return 0;
    }
    case 'release': {
      const { values } = parse({ 'skip-visionos': { type: 'boolean' } });
      return await release(print, { visionos: !values['skip-visionos'] }) ? 0 : 3;
    }
    case 'status': {
      const { values } = parse({ json: { type: 'boolean' } });
      return await status({ json: Boolean(values.json) });
    }
    case 'check': {
      const { values } = parse({ ...platformOption, apk: { type: 'string' } });
      const platform = platformFor(values.platform);
      return await check(print, resolve((values.apk as string | undefined) ?? (platform.id === 'quest' ? RELEASE_APK : buildTarget(platform, true).apk)), platform.id) ? 0 : 3;
    }
    case 'upload': {
      const { values } = parse({ ...platformOption, apk: { type: 'string' }, channel: { type: 'string' }, notes: { type: 'string' }, draft: { type: 'boolean' } });
      if (!values.apk || !values.channel) throw new UserError('upload needs --apk (from npm run app -- release) and --channel, for example alpha');
      await upload(print, { platform: platformFor(values.platform).id, apk: resolve(values.apk as string), channel: values.channel as string, notes: values.notes as string | undefined, draft: Boolean(values.draft) });
      return 0;
    }
    case 'analyze': {
      const { values, positionals } = parse({ out: { type: 'string' }, json: { type: 'boolean' } });
      const answer = await analyze({ target: positionals[0] ?? 'latest', out: resolve((values.out as string | undefined) ?? DEFAULT_OUT), json: Boolean(values.json) });
      return answer === 'yes' ? 0 : answer === 'no' ? 3 : 4;
    }
    default:
      throw new UserError(`unknown command ${command}\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, (error: unknown) => {
  if (error instanceof UserError) { console.error(error.message); process.exitCode = error.exitCode; return; }
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
