/** Local packaging guards use actual SDK output shapes, without requiring Android tools or a headset. */
import { describe, expect, it } from 'vitest';
import {
  androidXrProblems, manifestFacts, PACKAGE, parityProblems, parseBadging, parseSigner, parseXmlTree, storeProblems, UPLOAD_CERT_SHA256, uploadArgs, type ApkFacts,
} from '../app/tools/store.js';

const signerOutput = (prefix = 'Signer #1', digest = UPLOAD_CERT_SHA256) => `Verifies
Verified using v1 scheme (JAR signing): false
Verified using v2 scheme (APK Signature Scheme v2): true
Number of signers: 1
${prefix} certificate DN: CN=Polydance Capture, O=Polydance
${prefix} certificate SHA-256 digest: ${digest}
${prefix} public key SHA-256 digest: ${'b'.repeat(64)}
`;
const badging = `package: name='${PACKAGE}' versionCode='14' versionName='0.14.0' platformBuildVersionName='15'
install-location:'auto'
minSdkVersion:'30'
targetSdkVersion:'34'
application-label:'Polydance Capture'
uses-permission: name='android.permission.INTERNET'
launchable-activity: name='${PACKAGE}.MainActivity' label='' icon=''
native-code: 'arm64-v8a'
`;
const xml = `N: android=http://schemas.android.com/apk/res/android
  E: manifest (line=1)
    E: application (line=3)
      E: meta-data (line=4)
        A: http://schemas.android.com/apk/res/android:name(0x01010003)="com.oculus.supportedDevices" (Raw: "com.oculus.supportedDevices")
        A: http://schemas.android.com/apk/res/android:value(0x01010024)="quest3|quest3s" (Raw: "quest3|quest3s")
      E: activity (line=6)
        A: http://schemas.android.com/apk/res/android:excludeFromRecents(0x01010017)=true
        E: intent-filter (line=8)
          E: action (line=9)
            A: http://schemas.android.com/apk/res/android:name(0x01010003)="android.intent.action.MAIN" (Raw: "android.intent.action.MAIN")
`;
const facts = (): ApkFacts => ({ badging: parseBadging(badging), manifest: manifestFacts(parseXmlTree(xml)), signer: parseSigner(signerOutput()), bytes: 7900000 });

describe('APK signatures', () => {
  it.each(['Signer #1', 'V2 Signer:'])('reads the certificate from %s output, not the public-key hash', prefix => {
    expect(parseSigner(signerOutput(prefix))).toMatchObject({ verified: true, v2: true, signer: 'CN=Polydance Capture, O=Polydance', sha256: UPLOAD_CERT_SHA256, signerCount: 1 });
    expect(storeProblems({ ...facts(), signer: parseSigner(signerOutput(prefix)) })).toEqual([]);
  });
  it('rejects a different key even with the same distinguished name', () => {
    const other = { ...facts(), signer: parseSigner(signerOutput('Signer #1', 'a'.repeat(64))) };
    expect(storeProblems(other)).toContain('certificate does not match the pinned Polydance upload key, or the APK has an unexpected signer set');
  });
  it('fails closed on missing, multi-signer or failed signature output', () => {
    for (const text of ['', signerOutput().replace('Verifies\n', ''), signerOutput().replace('Number of signers: 1', 'Number of signers: 2'), signerOutput() + `Signer #2 certificate SHA-256 digest: ${'c'.repeat(64)}\n`]) {
      expect(storeProblems({ ...facts(), signer: parseSigner(text) }).length).toBeGreaterThan(0);
    }
  });
});

describe('local packaging rules', () => {
  it('reads the release manifest and badging', () => {
    expect(facts().manifest).toEqual({ excludeFromRecents: true, supportedDevices: 'quest3|quest3s', launcherHasMain: true, vrActivity: false, graphicsApi: false });
    expect(facts().badging).toMatchObject({ package: PACKAGE, versionCode: 14, minSdk: 30, targetSdk: 34, nativeCode: ['arm64-v8a'] });
    expect(storeProblems(facts())).toEqual([]);
  });
  it('rejects debug, prohibited permissions and 32-bit libraries', () => {
    const f = facts();
    f.badging = parseBadging(badging + "application-debuggable\nuses-permission: name='android.permission.PACKAGE_USAGE_STATS'\nnative-code: 'arm64-v8a' 'armeabi-v7a'\n");
    const problems = storeProblems(f).join('\n');
    expect(problems).toContain('debuggable'); expect(problems).toContain('PACKAGE_USAGE_STATS'); expect(problems).toContain('arm64-v8a only');
  });
  it('requires a Vulkan or GLES version once there is a VR activity, as Meta does', () => {
    const vr = xml + `      E: activity (line=12)
        E: intent-filter (line=13)
          E: category (line=14)
            A: http://schemas.android.com/apk/res/android:name(0x01010003)="com.oculus.intent.category.VR" (Raw: "com.oculus.intent.category.VR")
`;
    const vulkan = `    E: uses-feature (line=2)
      A: http://schemas.android.com/apk/res/android:name(0x01010003)="android.hardware.vulkan.version" (Raw: "android.hardware.vulkan.version")
      A: http://schemas.android.com/apk/res/android:version(0x0101021b)=(type 0x10)0x401000
`;
    const gles = `    E: uses-feature (line=2)
      A: http://schemas.android.com/apk/res/android:glEsVersion(0x01010281)=(type 0x11)0x30001
`;
    const withManifest = (text: string) => storeProblems({ ...facts(), manifest: manifestFacts(parseXmlTree(text)) }).join('\n');
    expect(withManifest(vr)).toContain('neither a Vulkan nor a GLES version');
    for (const feature of [vulkan, gles]) expect(withManifest(vr.replace('    E: application (line=3)\n', feature + '    E: application (line=3)\n'))).toBe('');
  });
  it('rejects SDK drift, missing launcher/devices, wrong package and size limit', () => {
    const f = facts(); f.badging.targetSdk = 32; f.badging.package = 'other'; f.manifest = manifestFacts(parseXmlTree('')); f.bytes = 1024 ** 3;
    const problems = storeProblems(f).join('\n');
    for (const part of ['targetSdkVersion', 'package', 'MAIN', 'excludeFromRecents', 'supportedDevices', 'under 1 GB']) expect(problems).toContain(part);
  });
});

/** The Android XR release of the same commit: no Meta manifest entries, no Meta SDK, the shared key and version. */
const xrBadging = badging.replace("versionName='0.14.0'", "versionName='0.14.0-androidxr'").replace("native-code: 'arm64-v8a'\n", '');
const xrXml = `N: android=http://schemas.android.com/apk/res/android
  E: manifest (line=1)
    E: application (line=3)
      E: activity (line=6)
        E: intent-filter (line=8)
          E: action (line=9)
            A: http://schemas.android.com/apk/res/android:name(0x01010003)="android.intent.action.MAIN" (Raw: "android.intent.action.MAIN")
`;
const xrFacts = (): ApkFacts => ({ badging: parseBadging(xrBadging), manifest: manifestFacts(parseXmlTree(xrXml)), signer: parseSigner(signerOutput()), bytes: 4200000 });

describe('Android XR release rules', () => {
  it('passes the Android XR flavor, which Meta\'s own rules would refuse', () => {
    expect(androidXrProblems(xrFacts())).toEqual([]);
    expect(storeProblems(xrFacts()).join('\n')).toMatch(/supportedDevices/);
  });
  it('refuses the Quest flavor, Meta leaks, a debug build and another key', () => {
    expect(androidXrProblems(facts()).join('\n')).toMatch(/lacks -androidxr[\s\S]*native code[\s\S]*supportedDevices[\s\S]*excludeFromRecents/);
    const f = xrFacts();
    f.badging = parseBadging(xrBadging + "application-debuggable\nuses-permission: name='com.oculus.permission.USE_SCENE'\n");
    f.signer = parseSigner(signerOutput('Signer #1', 'a'.repeat(64)));
    const problems = androidXrProblems(f).join('\n');
    for (const part of ['debuggable', 'com.oculus.permission.USE_SCENE', 'pinned Polydance upload key']) expect(problems).toContain(part);
  });
  it('requires one version and one key across the flavors', () => {
    expect(parityProblems(facts(), xrFacts())).toEqual([]);
    const behind = xrFacts(); behind.badging.versionCode = 13; behind.badging.versionName = '0.13.0-androidxr';
    expect(parityProblems(facts(), behind)).toEqual([expect.stringMatching(/versionCode differs: Quest 14, Android XR 13/), expect.stringMatching(/versionName differs/)]);
    const rekeyed = xrFacts(); rekeyed.signer = parseSigner(signerOutput('Signer #1', 'a'.repeat(64)));
    expect(parityProblems(facts(), rekeyed)).toEqual(['the flavors are signed with different keys']);
  });
});

describe('upload to a Meta test channel', () => {
  it('publishes to the channel with no age declaration, or leaves a draft when asked', () => {
    const args = uploadArgs('/x/polydance-quest-release-23.apk', 'ALPHA', 'tok', { notes: '3D viewer' });
    expect(args).toEqual(['upload-quest-build', '--app-id', '1300818073125870', '--token', 'tok', '--apk', '/x/polydance-quest-release-23.apk', '--channel', 'ALPHA', '--notes', '3D viewer', '--disable-progress-bar']);
    expect(args.some(a => /age|draft|validate/i.test(a))).toBe(false);
    expect(uploadArgs('a.apk', 'ALPHA', 'tok', { draft: true })).toContain('--draft');
  });
});
