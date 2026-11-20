/**
 * Polydance's store builds (docs/RELEASING.md, private/docs/STORE.md, private/docs/PLAY.md): the upload key, one
 * release of every flavor from main, local packaging guardrails, and upload to Meta's test channels. These
 * checks are not a complete Meta validation, VRC audit or Play review. Quest: signed with the upload key under
 * APK Signature Scheme v2, not debuggable, the manifest entries VRC.Quest.Packaging.1 asks for, no prohibited
 * permission, 64-bit native code only, under 1 GB. Android XR: the same identity, key and version, and
 * nothing of Meta's. The parsers read aapt2 and apksigner output and are pure, so the rules are tested
 * without an SDK. Secrets (the keystore password, Meta's upload token) live in owner-only files under
 * ~/.config/polycap and are never printed.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserError } from '../../src/errors.js';
import { exec } from '../../src/exec.js';
import { exists, privateDir, sha256File } from '../../src/fsx.js';
import { buildTarget, PLATFORMS, type Platform, type PlatformId } from './platform.js';
import {
  addDelivery, addRelease, ANDROID_XR_SUFFIX, findArtifact, ledgerSchema, parseGradleVersion, sourceProblems, versionProblems,
  visionAppProblems, visionInstalledSchema, type Artifact, type Ledger,
} from './releases.js';

export const PACKAGE = 'net.polydance.capture';
/** Polydance in Meta's Horizon Developer Dashboard. */
/** Polydance in Meta's Horizon Developer Dashboard, on the right team since 2026-10-12 (1593561244982561 was the wrong team's). */
export const META_APP_ID = '1300818073125870';
/** Public fingerprint of the upload key created 2026-10-08. Verify against any existing Meta build before first upload. */
export const UPLOAD_CERT_SHA256 = '6e64e0f64e1ce6c55df717f1629f7a895ec4c252672df41971aa746855ccde1a';
const MAX_BYTES = 1024 ** 3;

/** Meta's prohibited permissions (developers.meta.com/horizon/resources/permissions-prohibited, updated 2025-04-30): an upload declaring one fails. */
export const PROHIBITED = new Set(`ACCEPT_HANDOVER ACCESS_BACKGROUND_LOCATION ACCESS_CHECKIN_PROPERTIES ACCESS_LOCATION_EXTRA_COMMANDS
ACCESS_NOTIFICATION_POLICY ACCOUNT_MANAGER ACTIVITY_RECOGNITION ADD_VOICEMAIL ANSWER_PHONE_CALLS BIND_ACCESSIBILITY_SERVICE BIND_APPWIDGET
BIND_AUTOFILL_SERVICE BIND_CALL_REDIRECTION_SERVICE BIND_CARRIER_MESSAGING_CLIENT_SERVICE BIND_CARRIER_MESSAGING_SERVICE BIND_CARRIER_SERVICES
BIND_CHOOSER_TARGET_SERVICE BIND_CONDITION_PROVIDER_SERVICE BIND_CONTROLS BIND_DEVICE_ADMIN BIND_DREAM_SERVICE BIND_INCALL_SERVICE BIND_INPUT_METHOD
BIND_MIDI_DEVICE_SERVICE BIND_NFC_SERVICE BIND_NOTIFICATION_LISTENER_SERVICE BIND_PRINT_SERVICE BIND_QUICK_ACCESS_WALLET_SERVICE
BIND_QUICK_SETTINGS_TILE BIND_REMOTEVIEWS BIND_SCREENING_SERVICE BIND_TELECOM_CONNECTION_SERVICE BIND_TEXT_SERVICE BIND_TV_INPUT
BIND_VISUAL_VOICEMAIL_SERVICE BIND_VOICE_INTERACTION BIND_VR_LISTENER_SERVICE BIND_WALLPAPER BLUETOOTH_PRIVILEGED BODY_SENSORS
BROADCAST_PACKAGE_REMOVED BROADCAST_SMS BROADCAST_WAP_PUSH CALL_PHONE CALL_PRIVILEGED CAPTURE_AUDIO_OUTPUT CHANGE_COMPONENT_ENABLED_STATE
CHANGE_CONFIGURATION CLEAR_APP_CACHE CONTROL_LOCATION_UPDATES DELETE_CACHE_FILES DELETE_PACKAGES DIAGNOSTIC DUMP FACTORY_TEST GET_ACCOUNTS
GET_ACCOUNTS_PRIVILEGED INSTALL_LOCATION_PROVIDER INSTALL_PACKAGES INSTANT_APP_FOREGROUND_SERVICE LOADER_USAGE_STATS LOCATION_HARDWARE
MANAGE_DOCUMENTS MANAGE_MEDIA MANAGE_ONGOING_CALLS MASTER_CLEAR MEDIA_CONTENT_CONTROL MODIFY_PHONE_STATE MOUNT_FORMAT_FILESYSTEMS
MOUNT_UNMOUNT_FILESYSTEMS PACKAGE_USAGE_STATS PROCESS_OUTGOING_CALLS QUERY_ALL_PACKAGES READ_CALENDAR READ_CALL_LOG READ_CONTACTS
READ_INPUT_STATE READ_LOGS READ_PHONE_NUMBERS READ_PHONE_STATE READ_PRECISE_PHONE_STATE READ_SMS READ_VOICEMAIL REBOOT RECEIVE_MMS RECEIVE_SMS
RECEIVE_WAP_PUSH REQUEST_DELETE_PACKAGES REQUEST_INSTALL_PACKAGES SEND_RESPOND_VIA_MESSAGE SEND_SMS SET_ALWAYS_FINISH SET_ANIMATION_SCALE
SET_DEBUG_APP SET_PROCESS_LIMIT SET_TIME SET_TIME_ZONE SIGNAL_PERSISTENT_PROCESSES SMS_FINANCIAL_TRANSACTIONS
START_FOREGROUND_SERVICES_FROM_BACKGROUND START_VIEW_PERMISSION_USAGE STATUS_BAR SYSTEM_ALERT_WINDOW UNINSTALL_SHORTCUT UPDATE_DEVICE_STATS
USB_CAMERA USE_ICC_AUTH_WITH_DEVICE_IDENTIFIER USE_SIP UWB_RANGING WRITE_APN_SETTINGS WRITE_CALENDAR WRITE_CALL_LOG WRITE_CONTACTS
WRITE_GSERVICES WRITE_SECURE_SETTINGS WRITE_SETTINGS WRITE_VOICEMAIL`.split(/\s+/));

export interface Badging {
  package?: string; versionCode?: number; versionName?: string; minSdk?: number; targetSdk?: number;
  installLocation?: string; debuggable: boolean; permissions: string[]; nativeCode: string[]; launcher?: string; label?: string;
}

/** `aapt2 dump badging`: the package, SDK levels, permissions, debuggable, native code and the launcher activity. */
export function parseBadging(text: string): Badging {
  const out: Badging = { debuggable: false, permissions: [], nativeCode: [] };
  for (const line of text.split('\n')) {
    const pkg = line.match(/^package: name='([^']+)' versionCode='(\d+)' versionName='([^']*)'/);
    if (pkg) { out.package = pkg[1]; out.versionCode = Number(pkg[2]); out.versionName = pkg[3]; continue; }
    const value = (key: string) => line.match(new RegExp(`^${key}:'([^']*)'`))?.[1];
    out.minSdk ??= value('minSdkVersion') !== undefined ? Number(value('minSdkVersion')) : undefined;
    out.targetSdk ??= value('targetSdkVersion') !== undefined ? Number(value('targetSdkVersion')) : undefined;
    out.installLocation ??= value('install-location');
    out.label ??= value('application-label');
    if (line.trim() === 'application-debuggable') out.debuggable = true;
    const permission = line.match(/^uses-permission: name='([^']+)'/);
    if (permission) out.permissions.push(permission[1]);
    const native = line.match(/^native-code: (.*)$/);
    if (native) out.nativeCode = [...native[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
    const launcher = line.match(/^launchable-activity: name='([^']+)'/);
    if (launcher) out.launcher = launcher[1];
  }
  return out;
}

export interface XmlNode { tag: string; attrs: Record<string, string>; children: XmlNode[] }

/** `aapt2 dump xmltree --file AndroidManifest.xml`: elements (E:) and attributes (A:), nested by indentation. */
export function parseXmlTree(text: string): XmlNode {
  const root: XmlNode = { tag: '', attrs: {}, children: [] };
  const stack: { indent: number; node: XmlNode }[] = [{ indent: -1, node: root }];
  for (const line of text.split('\n')) {
    const indent = line.length - line.trimStart().length;
    const element = line.match(/^\s*E: (\S+)/);
    if (element) {
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
      const node: XmlNode = { tag: element[1], attrs: {}, children: [] };
      stack[stack.length - 1].node.children.push(node);
      stack.push({ indent, node });
      continue;
    }
    const attr = line.match(/^\s*A: (?:\S*:)?([A-Za-z]+)(?:\(0x[0-9a-f]+\))?=(.*)$/);
    if (attr) {
      const raw = attr[2];
      stack[stack.length - 1].node.attrs[attr[1]] = raw.startsWith('"') ? raw.slice(1, raw.indexOf('"', 1)) : raw.split(/\s/)[0];
    }
  }
  return root.children[0] ?? root;
}

const find = (node: XmlNode, tag: string): XmlNode[] => [...(node.tag === tag ? [node] : []), ...node.children.flatMap(c => find(c, tag))];

/** What the badging does not show: the launcher activity's excludeFromRecents, the supported devices, and whether
 *  an immersive (VR category) activity comes with the graphics API declaration Meta's upload requires for one. */
export function manifestFacts(manifest: XmlNode): { excludeFromRecents: boolean; supportedDevices?: string; launcherHasMain: boolean; vrActivity: boolean; graphicsApi: boolean } {
  const application = find(manifest, 'application')[0];
  const devices = application && find(application, 'meta-data').find(m => m.attrs.name === 'com.oculus.supportedDevices');
  const launcher = application && find(application, 'activity').find(a => find(a, 'action').some(x => x.attrs.name === 'android.intent.action.MAIN'));
  const vrActivity = Boolean(application) && find(application, 'activity').some(a => find(a, 'category').some(c => c.attrs.name === 'com.oculus.intent.category.VR'));
  const graphicsApi = find(manifest, 'uses-feature').some(f => f.attrs.name === 'android.hardware.vulkan.version' || f.attrs.glEsVersion !== undefined);
  return { excludeFromRecents: launcher?.attrs.excludeFromRecents === 'true', supportedDevices: devices?.attrs.value, launcherHasMain: Boolean(launcher), vrActivity, graphicsApi };
}

/** `apksigner verify --verbose --print-certs`: which schemes verified, and the signer's name. */
export function parseSigner(text: string): { verified: boolean; v2: boolean; signer?: string; sha256?: string; certificates: string[]; signerCount?: number } {
  // Build-tools 37 changed 'Signer #1' to 'V2 Signer'. Match certificate lines, never public-key digests.
  const prefix = '(?:Signer #\\d+|V[234](?:\\.\\d+)? Signer):?';
  const certificates = [...new Set([...text.matchAll(new RegExp(`^${prefix} certificate SHA-256 digest: ([0-9a-fA-F]{64})$`, 'gm'))].map(m => m[1].toLowerCase()))];
  return {
    verified: /^Verifies$/m.test(text),
    v2: /Verified using v2 scheme \(APK Signature Scheme v2\): true/.test(text),
    signer: text.match(new RegExp(`^${prefix} certificate DN: (.+)$`, 'm'))?.[1],
    sha256: certificates.length === 1 ? certificates[0] : undefined,
    certificates,
    signerCount: Number(text.match(/^Number of signers: (\d+)$/m)?.[1]) || undefined,
  };
}

export interface ApkFacts { badging: Badging; manifest: ReturnType<typeof manifestFacts>; signer: ReturnType<typeof parseSigner>; bytes: number }

/** Local packaging guardrails, not Meta approval, DUC, runtime verification, or a complete VRC audit. */
export function storeProblems(f: ApkFacts): string[] {
  const p: string[] = [];
  const b = f.badging;
  if (b.package !== PACKAGE) p.push(`package is ${b.package ?? 'missing'}, not ${PACKAGE}`);
  if (!b.versionCode) p.push('no versionCode');
  if (b.targetSdk !== 34) p.push(`targetSdkVersion ${b.targetSdk ?? 'missing'}: this app's verified build configuration targets 34; review current Meta policy before changing it`);
  if (b.minSdk === undefined || b.minSdk < 29 || b.minSdk > 34) p.push(`minSdkVersion ${b.minSdk ?? 'missing'}: Meta takes 29 to 34`);
  if (b.installLocation !== 'auto') p.push(`installLocation is ${b.installLocation ?? 'unset'}; Meta wants auto`);
  if (b.debuggable) p.push('the APK is debuggable; build the release variant');
  if (!b.label) p.push('no application label');
  const banned = b.permissions.filter(name => PROHIBITED.has(name.replace(/^android\.permission\./, '')));
  if (banned.length) p.push(`prohibited permission(s): ${banned.join(', ')}`);
  if (b.nativeCode.length && b.nativeCode.some(abi => abi !== 'arm64-v8a')) p.push(`native code for ${b.nativeCode.join(', ')}; ship arm64-v8a only`);
  if (!b.launcher || !f.manifest.launcherHasMain) p.push('no launcher activity with the MAIN action');
  if (!f.manifest.excludeFromRecents) p.push('the launcher activity does not set excludeFromRecents="true"');
  if (!f.manifest.supportedDevices) p.push('no com.oculus.supportedDevices meta-data');
  // ovr-platform-util refused 0.19.0 (26), the first build with a VR activity, for declaring neither (2026-10-21).
  if (f.manifest.vrActivity && !f.manifest.graphicsApi) p.push('a VR activity, but the manifest declares neither a Vulkan nor a GLES version; Meta refuses the upload');
  if (!f.signer.verified) p.push('the signature does not verify');
  if (!f.signer.v2) p.push('not signed with APK Signature Scheme v2');
  if (!f.signer.signer || /CN=Android Debug/.test(f.signer.signer)) p.push(`signed with ${f.signer.signer ?? 'no key'}; Meta needs the upload key (npm run app -- keystore)`);
  if (f.signer.signerCount !== 1 || f.signer.certificates.length !== 1 || f.signer.sha256 !== UPLOAD_CERT_SHA256) p.push('certificate does not match the pinned Polydance upload key, or the APK has an unexpected signer set');
  if (f.bytes <= 0 || f.bytes >= MAX_BYTES) p.push(`${(f.bytes / 1e9).toFixed(2)} GB; Meta takes APKs under 1 GB`);
  return p;
}

/** Android XR's release: the same identity, key and SDK levels as Quest's, and nothing of Meta's (app/PLATFORMS.md). */
export function androidXrProblems(f: ApkFacts): string[] {
  const p: string[] = [];
  const b = f.badging;
  if (b.package !== PACKAGE) p.push(`package is ${b.package ?? 'missing'}, not ${PACKAGE}`);
  if (!b.versionCode) p.push('no versionCode');
  if (!b.versionName?.endsWith(ANDROID_XR_SUFFIX)) p.push(`versionName ${b.versionName ?? 'missing'} lacks ${ANDROID_XR_SUFFIX}: this is not the Android XR flavor`);
  // 34 is Play's floor for Android XR on its XR track (private/docs/PLAY.md); the phone track would need more.
  if (b.targetSdk !== 34) p.push(`targetSdkVersion ${b.targetSdk ?? 'missing'}: the verified configuration targets 34; see private/docs/PLAY.md before changing it`);
  if (b.debuggable) p.push('the APK is debuggable; build the release variant');
  if (!b.label) p.push('no application label');
  const vendor = b.permissions.filter(name => /^com\.(oculus|meta)\./.test(name));
  if (vendor.length) p.push(`Meta permission(s) in the Android XR build: ${vendor.join(', ')}`);
  if (b.nativeCode.length) p.push(`native code (${b.nativeCode.join(', ')}): Meta's Platform SDK leaked into the Android XR build`);
  if (f.manifest.supportedDevices) p.push('com.oculus.supportedDevices in the Android XR build');
  if (f.manifest.excludeFromRecents) p.push('the launcher activity sets excludeFromRecents, a Quest store rule');
  if (!b.launcher || !f.manifest.launcherHasMain) p.push('no launcher activity with the MAIN action');
  if (!f.signer.verified) p.push('the signature does not verify');
  if (!f.signer.v2) p.push('not signed with APK Signature Scheme v2');
  if (f.signer.signerCount !== 1 || f.signer.certificates.length !== 1 || f.signer.sha256 !== UPLOAD_CERT_SHA256) p.push('certificate does not match the pinned Polydance upload key, or the APK has an unexpected signer set');
  return p;
}

export function releaseProblems(platform: PlatformId, f: ApkFacts): string[] {
  return platform === 'quest' ? storeProblems(f) : androidXrProblems(f);
}

/** One release is one versionCode, one name (plus Android XR's suffix) and one key across every flavor. */
export function parityProblems(quest: ApkFacts, xr: ApkFacts): string[] {
  const p: string[] = [];
  if (quest.badging.versionCode !== xr.badging.versionCode) p.push(`versionCode differs: Quest ${quest.badging.versionCode}, Android XR ${xr.badging.versionCode}`);
  if (`${quest.badging.versionName}${ANDROID_XR_SUFFIX}` !== xr.badging.versionName) p.push(`versionName differs: Quest ${quest.badging.versionName}, Android XR ${xr.badging.versionName}`);
  if (quest.signer.sha256 !== xr.signer.sha256) p.push('the flavors are signed with different keys');
  return p;
}

// ---- Commands.

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ANDROID = resolve(HERE, '../android');
/** Meta's store takes the Quest flavor (app/PLATFORMS.md); `check` defaults to it. */
export const RELEASE_APK = buildTarget(PLATFORMS.quest, true).apk;
const STORE_OUT = resolve(HERE, '../../.local/store');
const GRADLE_FILE = join(ANDROID, 'app/build.gradle.kts');
/** Checked in, so every worktree reads the same history (releases.ts). POLYCAP_RELEASE_LEDGER is for tests. */
const LEDGER_FILE = process.env.POLYCAP_RELEASE_LEDGER || resolve(HERE, '../releases.json');
/** visionos/build.sh, which builds, installs and asks the Vision Pro (docs/VISIONOS.md); tests give a stand-in. */
export const VISION_BUILD = process.env.POLYCAP_VISIONOS_BUILD || resolve(HERE, '../../visionos/build.sh');
const SIGNING_DIR = join(homedir(), '.config', 'polycap', 'android');
const SIGNING_FILE = process.env.POLYCAP_ANDROID_SIGNING || join(SIGNING_DIR, 'upload.properties');
const UPLOAD_TOKEN_FILE = join(homedir(), '.config', 'polycap', 'meta-upload-token');

/** A full JDK 17: JAVA_HOME if it has javac, else Homebrew's openjdk@17 (the README's build). */
async function javaHome(): Promise<string> {
  if (process.env.JAVA_HOME && await exists(join(process.env.JAVA_HOME, 'bin', 'javac'))) return process.env.JAVA_HOME;
  const brew = await exec('brew', ['--prefix', 'openjdk@17'], { allowFailure: true }).catch(() => ({ stdout: '', code: 1 }));
  const home = join(brew.stdout.trim(), 'libexec/openjdk.jdk/Contents/Home');
  if (brew.code === 0 && await exists(join(home, 'bin', 'javac'))) return home;
  throw new UserError('no JDK 17 with javac: brew install openjdk@17, or set JAVA_HOME');
}

/** The newest build-tools in the SDK named by ANDROID_HOME or app/android/local.properties. */
async function buildTools(): Promise<{ aapt2: string; apksigner: string }> {
  let sdk = process.env.ANDROID_HOME;
  if (!sdk) sdk = (await readFile(join(ANDROID, 'local.properties'), 'utf8').catch(() => '')).match(/^sdk\.dir=(.+)$/m)?.[1]?.trim();
  if (!sdk) throw new UserError('no Android SDK: set ANDROID_HOME or sdk.dir in app/android/local.properties');
  const versions = (await readdir(join(sdk, 'build-tools')).catch(() => [] as string[]))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const v of versions) {
    const dir = join(sdk, 'build-tools', v);
    if (await exists(join(dir, 'aapt2')) && await exists(join(dir, 'apksigner'))) return { aapt2: join(dir, 'aapt2'), apksigner: join(dir, 'apksigner') };
  }
  throw new UserError(`no build-tools with aapt2 and apksigner under ${sdk}/build-tools`);
}

async function privateFile(path: string, what: string): Promise<string> {
  const info = await stat(path).catch(() => { throw new UserError(`no ${what} at ${path}; see private/docs/STORE.md`); });
  if (info.mode & 0o077) throw new UserError(`${path} is readable by others; chmod 600 it`);
  return (await readFile(path, 'utf8')).trim();
}

/** Makes the upload key once. Refuses to replace one: a new key cannot update what the old one signed. */
export async function keystore(print: (line?: string) => void): Promise<void> {
  if (await exists(SIGNING_FILE)) throw new UserError(`${SIGNING_FILE} already exists; the upload key is made once and kept`);
  const store = join(SIGNING_DIR, 'upload.jks');
  if (await exists(store)) throw new UserError(`${store} already exists without ${SIGNING_FILE}; restore that file from the backup instead`);
  await privateDir(SIGNING_DIR);
  const keytool = join(await javaHome(), 'bin', 'keytool');
  // PKCS12 keeps one password for the store and the key; it reaches keytool through the environment, not argv.
  const password = randomBytes(24).toString('base64url');
  const env = { ...process.env, POLYCAP_KEYSTORE_PASSWORD: password };
  await exec(keytool, ['-genkeypair', '-keystore', store, '-storetype', 'PKCS12', '-alias', 'upload', '-keyalg', 'RSA', '-keysize', '4096',
    '-validity', '10000', '-dname', 'CN=Polydance Capture, O=Polydance', '-storepass:env', 'POLYCAP_KEYSTORE_PASSWORD', '-keypass:env', 'POLYCAP_KEYSTORE_PASSWORD'], { env });
  await chmod(store, 0o600);
  await writeFile(SIGNING_FILE, `storeFile=${store}\nstorePassword=${password}\nkeyAlias=upload\nkeyPassword=${password}\n`, { mode: 0o600 });
  const listing = await exec(keytool, ['-list', '-v', '-keystore', store, '-storepass:env', 'POLYCAP_KEYSTORE_PASSWORD'], { env });
  print(`Upload key made: ${store}`);
  print(`Its password is in ${SIGNING_FILE} (0600, not shown).`);
  print(listing.stdout.match(/SHA256: .+/)?.[0] ?? '');
  print('Back up both files now, together, somewhere other than this Mac (a password manager takes them). Every');
  print('build of Polydance on Meta\'s store must be signed with this key; without it the app cannot be updated.');
}

/** What aapt2 and apksigner say about an APK, checked against its platform's rules (Meta's for Quest). */
export async function checkApk(apk: string, platform: PlatformId = 'quest'): Promise<{ facts: ApkFacts; problems: string[] }> {
  const tools = await buildTools();
  const [badging, tree, signer, info] = await Promise.all([
    exec(tools.aapt2, ['dump', 'badging', apk]),
    exec(tools.aapt2, ['dump', 'xmltree', '--file', 'AndroidManifest.xml', apk]),
    exec(tools.apksigner, ['verify', '--verbose', '--print-certs', apk], { allowFailure: true, env: { ...process.env, JAVA_HOME: await javaHome() } }),
    stat(apk),
  ]);
  const facts = { badging: parseBadging(badging.stdout), manifest: manifestFacts(parseXmlTree(tree.stdout)), signer: { ...parseSigner(signer.stdout), verified: signer.code === 0 && parseSigner(signer.stdout).verified }, bytes: info.size };
  return { facts, problems: releaseProblems(platform, facts) };
}

function report(print: (line?: string) => void, apk: string, facts: ApkFacts, problems: string[]) {
  const b = facts.badging;
  print(`${apk}`);
  print(`  ${b.package} ${b.versionName} (${b.versionCode}) · min SDK ${b.minSdk}, target ${b.targetSdk} · ${(facts.bytes / 1e6).toFixed(1)} MB · native ${b.nativeCode.join(', ') || 'none'}`);
  print(`  signed by ${facts.signer.signer ?? 'nobody'}${facts.signer.sha256 ? `, SHA-256 ${facts.signer.sha256}` : ''}`);
  print(`  devices ${facts.manifest.supportedDevices ?? 'none'} · permissions ${b.permissions.map(p => p.replace(/^android\.permission\./, '')).join(', ')}`);
  print(problems.length ? `LOCAL APK CHECK FAILED:\n${problems.map(p => `  - ${p}`).join('\n')}` : 'Local APK packaging checks passed. Store validation and headset testing are still required.');
}

export async function check(print: (line?: string) => void, apk: string, platform: PlatformId = 'quest'): Promise<boolean> {
  if (!await exists(apk)) throw new UserError(`no APK at ${apk}; build it with npm run app -- release`);
  const { facts, problems } = await checkApk(apk, platform);
  report(print, apk, facts, problems);
  return problems.length === 0;
}

export async function readLedger(): Promise<Ledger> {
  if (!await exists(LEDGER_FILE)) return { releases: [] };
  const parsed = ledgerSchema.safeParse(JSON.parse(await readFile(LEDGER_FILE, 'utf8')));
  if (!parsed.success) throw new UserError(`${LEDGER_FILE} does not match the release ledger schema: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return parsed.data;
}

/** Replaced whole through a rename, so a crash never leaves half a ledger. Commit it afterwards (docs/RELEASING.md). */
async function writeLedger(ledger: Ledger): Promise<void> {
  const temp = `${LEDGER_FILE}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(ledgerSchema.parse(ledger), null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temp, LEDGER_FILE);
}

async function gitSource(): Promise<{ head: string; main?: string; dirty: boolean }> {
  const git = (args: string[]) => exec('git', args, { cwd: ANDROID, allowFailure: true });
  const [head, main, status] = await Promise.all([git(['rev-parse', 'HEAD']), git(['rev-parse', '--verify', '--quiet', 'refs/heads/main']), git(['status', '--porcelain', '--untracked-files=normal'])]);
  if (head.code !== 0 || status.code !== 0) throw new UserError('not a git checkout; releases are built from main');
  return { head: head.stdout.trim(), main: main.code === 0 ? main.stdout.trim() : undefined, dirty: status.stdout.trim() !== '' };
}

/** The source's shared version and whether HEAD is main's tip, for `status`. */
export async function sourceVersion(): Promise<{ versionCode: number; versionName: string; head: string; onMain: boolean }> {
  const [version, source] = await Promise.all([readFile(GRADLE_FILE, 'utf8').then(parseGradleVersion), gitSource()]);
  return { ...version, head: source.head, onMain: source.head === source.main };
}

/**
 * One release of every flavor from main's committed tip (docs/RELEASING.md): Quest's store APK, Android XR's
 * APK and Play bundle, Android XR's debug APK, which is what the AURA runs while a release build cannot
 * take a server over adb (private/docs/PLAY.md), and since 2026-11-12 the Vision Pro's app (docs/VISIONOS.md). Each is checked against its platform's rules and the others; copies
 * named by version go under .local/store, and the release goes in the ledger only when everything passed.
 * `visionos: false` (--skip-visionos) leaves the Vision Pro out, asked for by name: on 2026-11-19 this Mac's Xcode
 * lacked the visionOS platform and Robin chose not to hold Quest releases for it. The release then has no Vision Pro
 * artifact, and `status` says so.
 */
export async function release(print: (line?: string) => void, opts: { visionos: boolean } = { visionos: true }): Promise<boolean> {
  if (!await exists(SIGNING_FILE)) throw new UserError(`no upload key (${SIGNING_FILE}); make it once with npm run app -- keystore`);
  const source = await gitSource();
  const refused = sourceProblems(source);
  if (refused.length) throw new UserError(refused.join('\n'));
  const version = parseGradleVersion(await readFile(GRADLE_FILE, 'utf8'));
  const ledger = await readLedger();
  const stale = versionProblems(ledger, version.versionCode, source.head);
  if (stale.length) throw new UserError(stale.join('\n'));

  const xr = PLATFORMS['android-xr'];
  const apks = [
    ...Object.values(PLATFORMS).map(platform => ({ platform, variant: 'release' as const, target: buildTarget(platform, true) })),
    { platform: xr, variant: 'debug' as const, target: buildTarget(xr, false) },
  ];
  const bundle = { task: `bundle${xr.flavor[0].toUpperCase()}${xr.flavor.slice(1)}Release`, file: join(ANDROID, `app/build/outputs/bundle/${xr.flavor}Release/app-${xr.flavor}-release.aab`) };
  const tasks = [...apks.map(a => a.target.task), bundle.task];
  print(`building ${version.versionName} (${version.versionCode}) for ${Object.values(PLATFORMS).map(p => p.label).join(' and ')} from main ${source.head.slice(0, 7)} (clean, then ${tasks.join(', ')})…`);
  await exec(join(ANDROID, 'gradlew'), ['--console=plain', 'clean', ...tasks], {
    cwd: ANDROID, timeoutMs: 30 * 60_000, env: { ...process.env, JAVA_HOME: await javaHome() },
  });

  const out = join(STORE_OUT, `${version.versionName}-${version.versionCode}`);
  await privateDir(out);
  const artifacts: Artifact[] = [];
  const checked = new Map<PlatformId, ApkFacts>();
  let failed = false;
  const keep = async (from: string, file: string, platform: Platform | 'visionos', variant: Artifact['variant'], kind: Artifact['kind']) => {
    const kept = join(out, file);
    await copyFile(from, kept);
    await chmod(kept, 0o600);
    artifacts.push({ platform: platform === 'visionos' ? platform : platform.id, variant, kind, file, sha256: await sha256File(kept) });
    return kept;
  };
  for (const a of apks) {
    const kept = await keep(a.target.apk, `polydance-${a.platform.id}-${a.variant}-${version.versionName}-${version.versionCode}.apk`, a.platform, a.variant, 'apk');
    if (a.variant === 'debug') { print(`${kept}\n  ${a.platform.label} debug build for adb installs on test headsets (not for a store)`); continue; }
    const { facts, problems } = await checkApk(kept, a.platform.id);
    checked.set(a.platform.id, facts);
    print(`${a.platform.label}:`);
    report(print, kept, facts, problems);
    failed ||= problems.length > 0;
  }
  const keptBundle = await keep(bundle.file, `polydance-android-xr-release-${version.versionName}-${version.versionCode}.aab`, xr, 'release', 'aab');
  print(`${keptBundle}\n  ${xr.label} bundle for Google Play (private/docs/PLAY.md); its APK above is the same build`);
  const parity = parityProblems(checked.get('quest')!, checked.get('android-xr')!);
  if (parity.length) print(`FLAVORS DISAGREE:\n${parity.map(p => `  - ${p}`).join('\n')}`);

  // The Vision Pro, from the same commit and version (docs/VISIONOS.md): the Release configuration, signed for
  // development (it goes to Robin's headset over devicectl, not a store), zipped with ditto as the artifact.
  if (!opts.visionos) print(`Vision Pro: skipped (--skip-visionos); ${version.versionName} (${version.versionCode}) will have no Vision Pro build, and npm run app -- status will say so`);
  const built = opts.visionos ? await mkdtemp(join(tmpdir(), 'polydance-visionos-release-')) : undefined;
  if (built) try {
    print(`building the Vision Pro's ${version.versionName} (${version.versionCode}) with visionos/build.sh…`);
    await exec(VISION_BUILD, ['build', '--release', '--out', built], { cwd: resolve(HERE, '../..'), timeoutMs: 30 * 60_000 });
    const app = join(built, 'Polydance.app');
    const info = JSON.parse((await exec('plutil', ['-convert', 'json', '-o', '-', join(app, 'Info.plist')])).stdout) as Record<string, unknown>;
    const problems = visionAppProblems(info, { ...version, commit: source.head });
    const zip = `polydance-visionos-release-${version.versionName}-${version.versionCode}.zip`;
    await exec('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, join(built, zip)]);
    const kept = await keep(join(built, zip), zip, 'visionos', 'release', 'app');
    print(`Vision Pro:\n${kept}\n  ${String(info.CFBundleShortVersionString)} (${String(info.CFBundleVersion)}), commit ${String(info.PolydanceCommit)}`);
    for (const problem of problems) print(`  - ${problem}`);
    failed ||= problems.length > 0;
  } finally {
    await rm(built, { recursive: true, force: true });
  }
  for (const a of artifacts) print(`  sha256 ${a.sha256}  ${a.file}`);
  if (failed || parity.length) {
    print('Not recorded in app/releases.json: fix the problems above and release again.');
    return false;
  }
  await writeLedger(addRelease(ledger, {
    ...version, commit: source.head, builtAt: new Date().toISOString(), artifacts, deliveries: [],
  }, opts.visionos ? [] : ['visionos']));
  const file = (platform: Artifact['platform'], variant: Artifact['variant'], kind: Artifact['kind']) => join(out, artifacts.find(a => a.platform === platform && a.variant === variant && a.kind === kind)!.file);
  print(`Recorded ${version.versionName} (${version.versionCode}) in app/releases.json; commit it. Every headset gets this release:`);
  print(`  Quest (Meta Alpha):   npm run app -- upload --platform quest --apk ${file('quest', 'release', 'apk')} --channel alpha`);
  print(`  Android XR (AURA):    npm run app -- install --platform android-xr --apk ${file('android-xr', 'debug', 'apk')}`);
  print('  Android XR (Play):    upload the .aab to internal testing once the Play app exists (private/docs/PLAY.md)');
  if (opts.visionos) print(`  Vision Pro:           npm run app -- install --platform visionos --app ${file('visionos', 'release', 'app')}`);
  print('Then npm run app -- status shows what each platform and connected headset has.');
  return true;
}

/**
 * The Vision Pro over devicectl (visionos/build.sh): a release's zipped .app (or the last development build when
 * none is given) installed, and, for a release's own file, the delivery recorded once the headset reports that
 * build number. A development build is not a delivery.
 */
export async function installVision(print: (line?: string) => void, opts: { app?: string; device?: string; launch: boolean }): Promise<void> {
  const device = opts.device ? ['--device', opts.device] : [];
  const root = resolve(HERE, '../..');
  if (!opts.app) {
    await exec(VISION_BUILD, ['install', ...device], { cwd: root, timeoutMs: 10 * 60_000 });
    print('installed the last development build of Polydance for Vision Pro (npm run visionos -- build); not a release, so not recorded');
  } else {
    if (!opts.app.endsWith('.zip')) throw new UserError('--app is a release\'s zipped .app from npm run app -- release (polydance-visionos-release-….zip)');
    const sha = await sha256File(opts.app);
    const ledger = await readLedger();
    const found = findArtifact(ledger, sha);
    if (!found || found.artifact.platform !== 'visionos') throw new UserError(`${basename(opts.app)} is not a Vision Pro release in app/releases.json`);
    const unpacked = await mkdtemp(join(tmpdir(), 'polydance-visionos-install-'));
    try {
      await exec('ditto', ['-x', '-k', opts.app, unpacked]);
      await exec(VISION_BUILD, ['install', '--app', join(unpacked, 'Polydance.app'), ...device], { cwd: root, timeoutMs: 10 * 60_000 });
    } finally {
      await rm(unpacked, { recursive: true, force: true });
    }
    const seen = await visionInstalled(opts.device);
    if (!seen?.installed || seen.build !== String(found.release.versionCode)) {
      throw new UserError(`installed, but the Vision Pro reports build ${seen?.build ?? 'none'}, not ${found.release.versionCode}; nothing recorded`);
    }
    await writeLedger(addDelivery(ledger, sha, { to: `devicectl:${seen.model.replace(/[^A-Za-z0-9 _.,-]/g, '').slice(0, 60) || 'Vision Pro'}`, at: new Date().toISOString() }));
    print(`installed ${found.release.versionName} (${found.release.versionCode}) on ${seen.device}; recorded in app/releases.json, commit it.`);
  }
  if (opts.launch) await exec(VISION_BUILD, ['launch', ...device], { cwd: root, timeoutMs: 120_000 });
}

/** What the reachable Vision Pro has installed, or undefined when none can be reached (status then says so). */
export async function visionInstalled(device?: string) {
  const result = await exec(VISION_BUILD, ['installed', ...(device ? ['--device', device] : [])], { cwd: resolve(HERE, '../..'), timeoutMs: 120_000, allowFailure: true })
    .catch(() => undefined);
  if (!result || result.code !== 0) return undefined;
  const parsed = visionInstalledSchema.safeParse(JSON.parse(result.stdout.trim().split('\n').pop() ?? 'null'));
  if (!parsed.success) throw new UserError(`visionos/build.sh installed printed something unexpected: ${parsed.error.issues.map(i => i.message).join('; ')}`);
  return parsed.data;
}

/** Notes a ledger artifact installed over adb, so `status` knows the headset has it while it is not connected. */
export async function recordInstall(apk: string, model: string): Promise<string | undefined> {
  const sha = await sha256File(apk);
  const ledger = await readLedger();
  const found = findArtifact(ledger, sha);
  if (!found) return undefined;
  await writeLedger(addDelivery(ledger, sha, { to: `adb:${model.replace(/[^A-Za-z0-9 _.-]/g, '').slice(0, 60) || 'headset'}`, at: new Date().toISOString() }));
  return `${found.release.versionName} (${found.release.versionCode})`;
}

/**
 * Meta's tool's arguments for one test-channel upload, with no age declaration: the age group is the owner's
 * to declare in the dashboard, so this never sends one. Published to the channel at once, so testers can
 * update from the store page (Robin, 2026-10-20: the agent pushes, then the thread links to the store);
 * `draft` instead leaves it to be published in the dashboard, as builds 16 to 21 were sent by hand. The
 * tool validates the build as part of the upload (1.117 has no separate --validate).
 */
export function uploadArgs(apk: string, channel: string, token: string, opts: { notes?: string; draft?: boolean } = {}): string[] {
  return ['upload-quest-build', '--app-id', META_APP_ID, '--token', token, '--apk', apk, '--channel', channel,
    ...(opts.draft ? ['--draft'] : []), ...(opts.notes ? ['--notes', opts.notes] : []), '--disable-progress-bar'];
}

/**
 * Sends an APK to a release channel with Meta's ovr-platform-util and the user token from
 * ~/.config/polycap/meta-upload-token. The token goes to the tool as an argument, which is the only way
 * it takes one; it is never printed here.
 */
export async function upload(print: (line?: string) => void, opts: { apk: string; channel: string; notes?: string; platform?: PlatformId; draft?: boolean }): Promise<void> {
  if (opts.platform && opts.platform !== 'quest') throw new UserError('upload sends Quest builds to Meta; Android XR goes to Google Play, whose first upload is made in Play Console (private/docs/PLAY.md)');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(opts.channel)) throw new UserError(`--channel ${opts.channel} is not a release channel name such as alpha`);
  if (/^(store|production|live)$/i.test(opts.channel)) throw new UserError('this tool uploads to test channels only; a store release is a submission made in the dashboard');
  // Only a recorded release goes out, so the Android XR build of the same commit exists and status can tell who lacks it.
  const sha = await sha256File(opts.apk);
  const ledger = await readLedger();
  const found = findArtifact(ledger, sha);
  if (!found || found.artifact.platform !== 'quest' || found.artifact.variant !== 'release') {
    throw new UserError(`${basename(opts.apk)} is not a Quest release in app/releases.json; build one from main with npm run app -- release (docs/RELEASING.md)`);
  }
  if (!await check(print, opts.apk)) throw new UserError('not uploaded: fix the problems above first');
  const token = await privateFile(UPLOAD_TOKEN_FILE, 'Meta upload token');
  if (!/^\S{20,}$/.test(token)) throw new UserError(`${UPLOAD_TOKEN_FILE} does not hold a token (Account settings → Get Oculus platform utility token)`);
  const tool = process.env.POLYCAP_OVR_PLATFORM_UTIL || 'ovr-platform-util';
  print(`uploading to the ${opts.channel} channel of app ${META_APP_ID}${opts.draft ? ' as a draft, to publish in the dashboard' : ', published to it at once'}, with no age declaration…`);
  const result = await exec(tool, uploadArgs(opts.apk, opts.channel, token, { notes: opts.notes, draft: opts.draft }), { timeoutMs: 30 * 60_000, allowFailure: true }).catch(error => {
    throw new UserError(`${(error as Error).message.replaceAll(token, '<token>')}\nInstall Meta's ovr-platform-util (private/docs/STORE.md; Meta Quest Developer Hub keeps one in ~/Library/Application Support/odh) or set POLYCAP_OVR_PLATFORM_UTIL`);
  });
  const said = `${result.stdout}\n${result.stderr}`.replaceAll(token, '<token>').trim();
  print(said);
  if (result.code !== 0) throw new UserError(`ovr-platform-util failed (exit ${result.code})`);
  // Meta's build id when the tool prints one; the ledger keeps the delivery either way.
  const ref = said.match(/build[^0-9\n]{0,20}(\d{12,20})/i)?.[1];
  await writeLedger(addDelivery(ledger, sha, { to: `meta:${opts.channel.toUpperCase()}`, at: new Date().toISOString(), ...(ref ? { ref } : {}) }));
  print(`Recorded in app/releases.json; commit it. The Android XR build of ${found.release.versionName} (${found.release.versionCode}) must reach its headsets too: npm run app -- status`);
}
