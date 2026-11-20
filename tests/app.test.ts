/** The headset app's Mac-side tools: pure units, then the real CLI over ffmpeg-made videos. */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exec } from '../src/exec.js';
import {
  coveredMs, gaps, judge, longestSilence, parseBlackdetect, parseFreezedetect, parsePacketTimes, parseTimeline, recordingEndMs,
  windowReport, windows, type ProbeEvent, type VideoFacts,
} from '../app/tools/analysis.js';
import { chooseDevice, connectFailureHint, connectSucceeded, isNetworkSerial, parseLogsGrant, parseWifiIp, recordingInProgress } from '../app/tools/device.js';
import { hasFfmpeg } from './helpers/fake-tools.js';

let clock = 0;
const ev = (rel: number | null, src: string, name: string, extra: Record<string, unknown> = {}): ProbeEvent =>
  ({ t: 1_790_000_000_000 + (clock += 1), up: 1000 + clock, rel, src, ev: name, ...extra });

/** A run that records for `endMs`, is hidden between `away[0]` and `away[1]`, and stops by `reason`. */
function timeline(endMs: number, away: [number, number] | null, reason = 'user'): ProbeEvent[] {
  const body: ProbeEvent[] = [];
  for (let rel = 1000; rel < endMs; rel += 1000) body.push(ev(rel, 'service', 'heartbeat', { intervalMs: 1000, mic: 1200 }));
  if (away) body.push(ev(away[0], 'activity', 'pause'), ev(away[0], 'activity', 'stop'), ev(away[1], 'activity', 'start'), ev(away[1], 'activity', 'resume'));
  body.sort((x, y) => (x.rel ?? 0) - (y.rel ?? 0));
  return [
    ev(null, 'probe', 'consent_result', { ok: true }), ev(0, 'recorder', 'started'), ...body,
    ev(endMs, 'service', 'finishing', { reason }), ev(endMs, 'recorder', 'stopped'),
  ];
}
const toJsonl = (events: ProbeEvent[]) => events.map(e => JSON.stringify(e)).join('\n') + '\n';
const steady = (fromMs: number, toMs: number, stepMs = 100) => Array.from({ length: Math.floor((toMs - fromMs) / stepMs) + 1 }, (_, i) => fromMs + i * stepMs);

describe('app timeline', () => {
  it('parses lines and names the line that is wrong', () => {
    expect(parseTimeline(toJsonl(timeline(3000, null)))).toHaveLength(6);
    expect(() => parseTimeline('{"t":1,"up":1,"rel":null,"src":"a","ev":"b"}\nnot json\n')).toThrow(/line 2 is not JSON/);
    expect(() => parseTimeline('{"t":1,"up":1,"src":"a","ev":"b"}\n')).toThrow(/line 1: rel/);
  });

  it('finds hidden and unfocused periods, and closes one left open at the end', () => {
    const events = timeline(10_000, [2000, 7000]);
    expect(windows(events, 'hidden')).toEqual([{ kind: 'hidden', startMs: 2000, endMs: 7000, open: false }]);
    expect(windows(events, 'unfocused')).toEqual([{ kind: 'unfocused', startMs: 2000, endMs: 7000, open: false }]);
    const killed = timeline(10_000, [2000, 99_000]).filter(e => e.ev !== 'start' && e.ev !== 'resume');
    expect(windows(killed, 'hidden')).toEqual([{ kind: 'hidden', startMs: 2000, endMs: 10_000, open: true }]);
    expect(recordingEndMs(killed)).toBe(10_000);
  });

  it('ignores lifecycle before the recorder started', () => {
    const events = [ev(null, 'activity', 'stop'), ev(null, 'activity', 'start'), ...timeline(4000, null)];
    expect(windows(events, 'hidden')).toEqual([]);
  });
});

describe('app frame rules', () => {
  it('measures gaps and silence including the window edges', () => {
    const pts = [0, 100, 200, 3000, 3100];
    expect(gaps(pts, 500)).toEqual([{ startMs: 200, endMs: 3000, ms: 2800 }]);
    expect(longestSilence(pts, { startMs: 0, endMs: 3100 }).ms).toBe(2800);
    expect(longestSilence([500, 600], { startMs: 0, endMs: 5000 })).toEqual({ startMs: 600, endMs: 5000, ms: 4400 });
  });

  it('reads packet times without inventing a frame from the trailing blank line', () => {
    expect(parsePacketTimes('0.705700\n0.747367\nN/A\n0.775144\n\n', 0)).toEqual([706, 747, 775]);
    expect(gaps(parsePacketTimes('0.705700\n0.747367\n', 0), 500)).toEqual([]);
    expect(parsePacketTimes('10.5\n10.0\n', 10)).toEqual([0, 500]);
  });

  it('reads blackdetect and freezedetect output', () => {
    expect(parseBlackdetect('[blackdetect @ 0x1] black_start:2 black_end:7.04 black_duration:5.04\n')).toEqual([{ startMs: 2000, endMs: 7040 }]);
    const freeze = '[freezedetect @ 0x2] lavfi.freezedetect.freeze_start: 1.5\n[freezedetect @ 0x2] lavfi.freezedetect.freeze_duration: 2\n' +
      '[freezedetect @ 0x2] lavfi.freezedetect.freeze_end: 3.5\n[freezedetect @ 0x2] lavfi.freezedetect.freeze_start: 8\n';
    expect(parseFreezedetect(freeze, 10_000)).toEqual([{ startMs: 1500, endMs: 3500 }, { startMs: 8000, endMs: 10_000 }]);
    expect(coveredMs([{ startMs: 0, endMs: 3000 }, { startMs: 8000, endMs: 20_000 }], { startMs: 2000, endMs: 9000 })).toBe(2000);
  });
});

describe('app verdict', () => {
  const video = (pts: number[], black: VideoFacts['black'] = []): VideoFacts => ({ durationMs: pts[pts.length - 1] ?? 0, ptsMs: pts, black, frozen: [] });
  const verdict = (events: ProbeEvent[], facts: VideoFacts) => judge({
    reason: events.find(e => e.ev === 'finishing')?.reason as string | undefined, recordingMs: recordingEndMs(events), video: facts,
    hidden: windows(events, 'hidden').map(w => windowReport(w, events, facts)), mic: true,
  });

  it('says yes when frames keep coming through the away period and after it', () => {
    const events = timeline(20_000, [3000, 15_000]);
    const result = verdict(events, video(steady(0, 20_000)));
    expect(result).toEqual({ answer: 'yes', reasons: ['video continued through 1 away period(s) and after each return'], warnings: [] });
  });

  it('says no when the system ended the projection while away', () => {
    const events = timeline(9000, [3000, 99_000], 'projection_stopped').filter(e => e.ev !== 'start' && e.ev !== 'resume');
    const result = verdict(events, video(steady(0, 9000)));
    expect(result.answer).toBe('no');
    expect(result.reasons.join('\n')).toMatch(/ended by itself: projection_stopped/);
    expect(result.reasons.join('\n')).toMatch(/ended before the probe was shown again/);
  });

  it('says no when frames stop or turn black while away, and when nothing came after returning', () => {
    const events = timeline(20_000, [3000, 12_000]);
    const stalled = verdict(events, video([...steady(0, 4000), ...steady(19_000, 20_000)]));
    expect(stalled.answer).toBe('no');
    expect(stalled.reasons.join('\n')).toMatch(/no frames for 8\.0 s from 00:04\.0/);
    expect(stalled.reasons.join('\n')).toMatch(/no frames in the 3 s after coming back/);
    const black = verdict(events, video(steady(0, 20_000), [{ startMs: 3000, endMs: 12_000 }]));
    expect(black.reasons).toEqual(['away 00:03.0–00:12.0: 100% of the frames are black']);
  });

  it('warns, without changing the answer, when in-app audio was asked for and read zero while away', () => {
    const events = timeline(20_000, [3000, 15_000]).map(e => (e.ev === 'heartbeat' ? { ...e, app: 0 } : e));
    const facts = video(steady(0, 20_000));
    const hidden = windows(events, 'hidden').map(w => windowReport(w, events, facts));
    expect(hidden[0].appPeak).toBe(0);
    const result = judge({ reason: 'user', recordingMs: 20_000, video: facts, hidden, mic: true, app: true });
    expect(result.answer).toBe('yes');
    expect(result.warnings.join('\n')).toMatch(/in-app audio read zero/);
    expect(judge({ reason: 'user', recordingMs: 20_000, video: facts, hidden, mic: true, app: false }).warnings).toEqual([]);
  });

  it('is inconclusive when the probe was never hidden long enough, and warns about a silent mic', () => {
    expect(verdict(timeline(10_000, [2000, 4000]), video(steady(0, 10_000))).answer).toBe('inconclusive');
    const quiet = timeline(20_000, [3000, 15_000]).map(e => (e.ev === 'heartbeat' ? { ...e, mic: 0 } : e));
    const result = verdict(quiet, video(steady(0, 20_000)));
    expect(result.answer).toBe('yes');
    expect(result.warnings.join('\n')).toMatch(/microphone read zero/);
  });
});

describe('app devices', () => {
  const puck = { serial: '192.168.1.104:41735', state: 'device', model: 'Android_XR_Puck' };
  const questUsb = { serial: '2G0YC1ZF8B0123', state: 'device', model: 'Quest_3' };
  const questWifi = { serial: '192.168.1.50:5555', state: 'device', model: 'Quest_3' };

  it('prefers the one Quest over the puck, and filters to USB for the Wi-Fi switch', () => {
    expect(chooseDevice([puck, questWifi], undefined).serial).toBe(questWifi.serial);
    expect(chooseDevice([puck, questUsb, questWifi], undefined, 'usb').serial).toBe(questUsb.serial);
    expect(() => chooseDevice([puck], undefined)).toThrow(/no Quest among/);
  });

  it('treats one headset on USB and Wi-Fi as one, preferring USB', () => {
    const same = new Map([[questUsb.serial, 'HW1'], [questWifi.serial, 'HW1']]);
    expect(chooseDevice([puck, questWifi, questUsb], undefined, 'any', same).serial).toBe(questUsb.serial);
    const different = new Map([[questUsb.serial, 'HW1'], [questWifi.serial, 'HW2']]);
    expect(() => chooseDevice([questUsb, questWifi], undefined, 'any', different)).toThrow(/several Quests/);
  });

  it('refuses ambiguity and explains an unauthorised headset', () => {
    expect(() => chooseDevice([questUsb, questWifi], undefined)).toThrow(/several Quests/);
    expect(() => chooseDevice([puck, { ...puck, serial: 'X1', model: 'Pixel' }], undefined)).toThrow(/no Quest among/);
    expect(() => chooseDevice([{ ...questUsb, state: 'unauthorized' }], questUsb.serial)).toThrow(/accept the debugging prompt/);
    expect(() => chooseDevice([puck], undefined, 'usb')).toThrow(/no USB device/);
    expect(() => chooseDevice([puck, { ...questWifi, state: 'offline' }], undefined)).toThrow(/is offline: wake the headset/);
  });

  it('sees a recording in progress from the service or from a growing file', () => {
    const running = 'ACTIVITY MANAGER SERVICES\n  * ServiceRecord{9f1 u0 net.polydance.capture/.RecorderService}\n    isForeground=true foregroundId=1\n';
    expect(recordingInProgress(running, undefined, 1000)).toBe(true);
    expect(recordingInProgress('ACTIVITY MANAGER SERVICES\n  (nothing)\n', 998, 1000)).toBe(true);
    expect(recordingInProgress('ACTIVITY MANAGER SERVICES\n  (nothing)\n', 900, 1000)).toBe(false);
    expect(recordingInProgress('', undefined, 1000)).toBe(false);
  });

  it('reads from dumpsys package whether Polydance declares READ_LOGS and has been granted it (docs/LOGS.md)', () => {
    const dump = (requested: string, granted: string) => `Packages:\n  Package [net.polydance.capture] (1a2b3c):\n    requested permissions:\n      android.permission.RECORD_AUDIO\n${requested}    install permissions:\n      android.permission.INTERNET: granted=true\n${granted}`;
    expect(parseLogsGrant('Unable to find package: net.polydance.capture\n')).toEqual({ installed: false, declared: false, granted: false });
    // A store build leaves the permission out (Meta prohibits it), so nothing can grant it.
    expect(parseLogsGrant(dump('', ''))).toEqual({ installed: true, declared: false, granted: false });
    expect(parseLogsGrant(dump('      android.permission.READ_LOGS\n', '      android.permission.READ_LOGS: granted=false\n'))).toEqual({ installed: true, declared: true, granted: false });
    expect(parseLogsGrant(dump('      android.permission.READ_LOGS\n', '      android.permission.READ_LOGS: granted=true\n'))).toEqual({ installed: true, declared: true, granted: true });
  });

  it('reads the Wi-Fi address and the connect result', () => {
    expect(parseWifiIp('10.0.0.0/8 dev tun0 scope link src 10.1.2.3\n192.168.1.0/24 dev wlan0 proto kernel scope link src 192.168.1.50\n')).toBe('192.168.1.50');
    expect(parseWifiIp('nothing here')).toBeUndefined();
    expect(connectSucceeded('connected to 192.168.1.50:5555\n')).toBe(true);
    expect(connectSucceeded('already connected to 192.168.1.50:5555\n')).toBe(true);
    // macOS keeping the adb server off the local network reads as no route; anything else is the old hint.
    expect(connectFailureHint("failed to connect to '192.168.1.196:5555': No route to host")).toMatch(/adb kill-server.*Meta Quest Developer Hub/);
    expect(connectFailureHint("failed to connect to '192.168.1.196:5555': Connection refused")).toMatch(/Same network.*Wi-Fi adb/);
    expect(connectSucceeded('failed to connect to 192.168.1.50:5555: Connection refused\n')).toBe(false);
    expect(isNetworkSerial('192.168.1.50:5555')).toBe(true);
    expect(isNetworkSerial('adb-2G0YC-abc._adb-tls-connect._tcp')).toBe(true);
    expect(isNetworkSerial('2G0YC1ZF8B0123')).toBe(false);
  });
});

const ffmpeg = await hasFfmpeg();
(ffmpeg ? describe : describe.skip)('app analyze, end to end with ffmpeg', () => {
  const probe = (dir: string) => exec('npx', ['tsx', 'app/tools/cli.ts', 'analyze', dir, '--json'], { allowFailure: true, timeoutMs: 120_000 });
  async function run(name: string, events: ProbeEvent[], ffmpegArgs: string[], config: Record<string, unknown> = { width: 320, height: 240, mic: false }): Promise<string> {
    const dir = join(await mkdtemp(join(tmpdir(), 'polycap-app-')), name);
    await exec('mkdir', ['-p', dir]);
    await exec('ffmpeg', ['-y', '-v', 'error', ...ffmpegArgs, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'video.mp4')]);
    await writeFile(join(dir, 'timeline.jsonl'), toJsonl(events));
    await writeFile(join(dir, 'run.json'), JSON.stringify({
      config,
      device: { manufacturer: 'Oculus', model: 'Quest 3', release: '14', sdk: 34, display: 'test' },
    }));
    return dir;
  }

  it('answers yes for continuous video and writes the away frame', async () => {
    const dir = await run('20261001-120000', timeline(10_000, [1000, 7000]), ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=10']);
    const result = await probe(dir);
    expect(result.code).toBe(0);
    const analysis = JSON.parse(result.stdout);
    expect(analysis.verdict.answer).toBe('yes');
    expect(analysis.hidden[0]).toMatchObject({ startMs: 1000, endMs: 7000, blackFraction: 0 });
    expect(analysis.hidden[0].frames).toBeGreaterThanOrEqual(59);
    expect(analysis.frames).toEqual(['away-1.jpg']);
    expect(JSON.parse(await readFile(join(dir, 'analysis.json'), 'utf8')).verdict.answer).toBe('yes');
  });

  it('answers no when the away period goes black and then stops producing frames', async () => {
    // 0-2 s pattern, 2-7 s black, then nothing until the pattern returns at 10 s.
    const dir = await run('20261001-120100', timeline(13_600, [1500, 10_500]), [
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=2',
      '-f', 'lavfi', '-i', 'color=c=black:size=320x240:rate=10:duration=5',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=3',
      '-filter_complex', "[0][1][2]concat=n=3:v=1:a=0,setpts='if(gte(T,7),PTS+3/TB,PTS)'", '-fps_mode', 'passthrough',
    ]);
    const result = await probe(dir);
    expect(result.code).toBe(3);
    const analysis = JSON.parse(result.stdout);
    expect(analysis.verdict.answer).toBe('no');
    const reasons = analysis.verdict.reasons.join('\n');
    expect(reasons).toMatch(/% of the frames are black/);
    expect(reasons).toMatch(/no frames for 3\.\d s from 00:06\.9/);
    expect(analysis.video.gapsOver500ms).toHaveLength(1);
  });

  it('names and measures each audio track from run.json, mic first', async () => {
    const dir = await run('20261001-120200', timeline(10_000, [1000, 7000]), [
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=10,volume=0.05',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=10,volume=0.8,aformat=channel_layouts=stereo',
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:a', 'aac',
    ], { width: 320, height: 240, mic: true, appAudio: true, engine: 'muxer', audioTracks: ['mic', 'app'] });
    const result = await probe(dir);
    expect(result.code).toBe(0);
    const audio = JSON.parse(result.stdout).video.audio;
    expect(audio.map((a: { name: string; channels: number }) => [a.name, a.channels])).toEqual([['mic', 1], ['app', 2]]);
    expect(audio[1].maxDb).toBeGreaterThan(audio[0].maxDb + 10);
  });
});
