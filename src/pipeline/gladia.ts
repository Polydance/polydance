/**
 * Gladia's pre-recorded API as a Transcriber. Only the wavs the audio step made (16 kHz mono) are sent,
 * never the video: for a recording the narration track, never game audio; for a call (2026-11-05) the
 * mic and the call's sound each as its own job, so choosing Gladia for calls sends the other
 * participants' voices too (docs/MAC.md PV4). Each job, with its copy of the audio, is deleted at
 * Gladia once the transcript is read, unless POLYCAP_GLADIA_KEEP_JOBS=1.
 * Flow: POST /v2/upload, POST /v2/pre-recorded, poll GET /v2/pre-recorded/{id}, DELETE it.
 */
import { openAsBlob } from 'node:fs';
import { z } from 'zod';
import { sleep } from '../fsx.js';
import type { Transcript, Transcriber, TranscriptSegment } from './transcribe.js';

const uploadSchema = z.looseObject({ audio_url: z.string().url() });
const jobSchema = z.looseObject({ id: z.string().min(1) });
const wordSchema = z.looseObject({ word: z.string(), start: z.number(), end: z.number() });
const utteranceSchema = z.looseObject({ start: z.number(), end: z.number(), text: z.string(), language: z.string().optional(), words: z.array(wordSchema).optional() });
const resultSchema = z.looseObject({
  id: z.string(),
  status: z.enum(['queued', 'processing', 'done', 'error']),
  error_code: z.number().nullable().optional(),
  result: z.looseObject({
    transcription: z.looseObject({ utterances: z.array(utteranceSchema), languages: z.array(z.string()).optional() }).optional(),
  }).nullable().optional(),
});
export type GladiaResult = z.infer<typeof resultSchema>;

const ms = (seconds: number) => Math.max(0, Math.round(seconds * 1000));

/** Utterances (seconds) to segments (milliseconds), with their words; empty text is dropped. */
export function parseGladiaResult(result: GladiaResult): Pick<Transcript, 'language' | 'segments'> {
  const transcription = result.result?.transcription;
  if (!transcription) throw new Error(`Gladia job ${result.id} is done but has no transcription`);
  const segments: TranscriptSegment[] = transcription.utterances
    .map(u => {
      const words = (u.words ?? []).map(w => ({ text: w.word.trim(), startMs: ms(w.start), endMs: ms(w.end) })).filter(w => w.text && w.endMs >= w.startMs);
      return { startMs: ms(u.start), endMs: ms(u.end), text: u.text.trim(), ...(words.length ? { words } : {}) };
    })
    .filter(s => s.text && s.endMs >= s.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  return { language: transcription.languages?.[0] ?? transcription.utterances[0]?.language, segments };
}

export interface GladiaOptions { pollMs?: number; timeoutMs?: number; deleteJobs?: boolean }

export class GladiaTranscriber implements Transcriber {
  readonly kind = 'gladia';
  constructor(private readonly key: string, private readonly baseUrl: string, private readonly language: string, private readonly options: GladiaOptions = {}) {}

  describe() { return `Gladia pre-recorded (${new URL(this.baseUrl).host}, language ${this.language}${this.options.deleteJobs === false ? '' : ', jobs deleted after reading'})`; }

  async transcribe(wav: string): Promise<Transcript> {
    const form = new FormData();
    form.append('audio', await openAsBlob(wav, { type: 'audio/wav' }), 'narration.wav');
    const upload = uploadSchema.parse(await this.call('POST', '/v2/upload', form));
    const job = jobSchema.parse(await this.call('POST', '/v2/pre-recorded', { audio_url: upload.audio_url, language_config: { languages: [this.language] } }));
    let result: GladiaResult | undefined;
    let failure: unknown;
    try { result = await this.waitFor(job.id); } catch (error) { failure = error; }
    // Delete whether or not it worked; a job still running cannot be deleted, which only happens on a timeout.
    const fate = this.options.deleteJobs === false
      ? 'kept at Gladia (POLYCAP_GLADIA_KEEP_JOBS=1)'
      : await this.call('DELETE', `/v2/pre-recorded/${encodeURIComponent(job.id)}`)
        .then(() => 'deleted at Gladia', error => `NOT deleted at Gladia: ${error instanceof Error ? error.message : String(error)}`);
    if (!result) throw new Error(`${failure instanceof Error ? failure.message : String(failure)}; job ${fate}`);
    return { engine: this.kind, ...parseGladiaResult(result), note: `Gladia job ${fate}` };
  }

  private async waitFor(id: string): Promise<GladiaResult> {
    const deadline = Date.now() + (this.options.timeoutMs ?? 30 * 60_000);
    for (;;) {
      const result = resultSchema.parse(await this.call('GET', `/v2/pre-recorded/${encodeURIComponent(id)}`));
      if (result.status === 'done') return result;
      if (result.status === 'error') throw new Error(`Gladia job ${id} failed with code ${result.error_code ?? 'unknown'}`);
      if (Date.now() > deadline) throw new Error(`Gladia job ${id} still ${result.status} after ${Math.round((this.options.timeoutMs ?? 1_800_000) / 60_000)} min`);
      await sleep(this.options.pollMs ?? 3000);
    }
  }

  private async call(method: string, path: string, body?: FormData | object): Promise<unknown> {
    const headers: Record<string, string> = { 'x-gladia-key': this.key };
    let payload: FormData | string | undefined;
    if (body instanceof FormData) payload = body;
    else if (body) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
    const response = await fetch(`${this.baseUrl}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(10 * 60_000) });
    const text = await response.text();
    // The key is never echoed; Gladia's error body is short and says what was wrong.
    if (!response.ok) throw new Error(`Gladia ${method} ${path.split('/').slice(0, 3).join('/')} returned ${response.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }
}
