import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Config } from '../config.js';
import { UserError } from '../errors.js';
import { exec } from '../exec.js';
import { exists } from '../fsx.js';
import { VOICES, type Voice } from '../session.js';
import { formatClock } from '../time.js';
import { GladiaTranscriber } from './gladia.js';
import { lineText, speakerSchema, type Speaker } from './voices.js';

/** Word timings when the engine gives them (Gladia does); they let frames land on "this" and "that". */
export interface TranscriptWord { text: string; startMs: number; endMs: number }
/**
 * `speaker` only in a call's transcript, where the mic (me) and the call's sound (others) are transcribed
 * apart (2026-11-05); `name` on an Others line when Meet showed who was speaking it (speakers.ts, 2026-11-11).
 */
export interface TranscriptSegment { startMs: number; endMs: number; text: string; words?: TranscriptWord[]; speaker?: Speaker; name?: string }
export interface Transcript { engine: string; model?: string; language?: string; segments: TranscriptSegment[]; note?: string }
/** `call`: one track of a call, silent for much of its length (whisper.cpp then runs with -mc 0 -sns). */
export interface TranscribeOptions { call?: boolean }
export interface Transcriber {
  readonly kind: string;
  describe(): string;
  /** May fail loudly; the pipeline records the failure and still extracts frames. */
  transcribe(wav: string, workPrefix: string, options?: TranscribeOptions): Promise<Transcript>;
}

export const transcriptFileSchema = z.strictObject({
  version: z.literal(1), engine: z.string(), model: z.string().optional(), language: z.string().optional(),
  /** Whose voice this is (session.ts VOICES); `app` means no microphone was recorded and these are not the user's words. */
  voice: z.enum(VOICES).optional(),
  /** A call's microphone lines dropped as the far end heard through the speakers (voices.ts BLEED). */
  bleedDropped: z.number().int().nonnegative().optional(),
  segments: z.array(z.strictObject({
    startMs: z.number().int().nonnegative(), endMs: z.number().int().nonnegative(), text: z.string(),
    words: z.array(z.strictObject({ text: z.string(), startMs: z.number().int().nonnegative(), endMs: z.number().int().nonnegative() })).optional(),
    speaker: speakerSchema.optional(),
    /** The person Meet's speaking ring was on for an Others line (speakers.ts); never on Me's lines. */
    name: z.string().min(1).max(200).optional(),
  })),
});
export type TranscriptFile = z.infer<typeof transcriptFileSchema>;

const whisperJsonSchema = z.object({
  result: z.object({ language: z.string().optional() }).optional(),
  transcription: z.array(z.object({ offsets: z.object({ from: z.number(), to: z.number() }), text: z.string() })),
});
// whisper.cpp labels non-speech as "[BLANK_AUDIO]", "[Music]" or "(door closes)"; those are not feedback.
const NON_SPEECH = /^\s*(\[[^\]]*\]|\([^)]*\))\s*$/;

/** whisper.cpp `-oj` output: offsets are milliseconds. */
export function parseWhisperJson(raw: string): Pick<Transcript, 'language' | 'segments'> {
  const data = whisperJsonSchema.parse(JSON.parse(raw));
  const segments = data.transcription
    .map(s => ({ startMs: Math.round(s.offsets.from), endMs: Math.round(s.offsets.to), text: s.text.trim() }))
    .filter(s => s.text && !NON_SPEECH.test(s.text) && s.endMs >= s.startMs);
  return { language: data.result?.language, segments };
}

export class WhisperCppTranscriber implements Transcriber {
  readonly kind = 'whisper-cpp';
  constructor(private readonly bin: string, private readonly model: string, private readonly language: string, private readonly threads: number) {}
  describe() { return `whisper.cpp (${this.bin}, model ${this.model}, language ${this.language})`; }
  async transcribe(wav: string, workPrefix: string, options: TranscribeOptions = {}): Promise<Transcript> {
    if (!await exists(this.model)) throw new UserError(`Whisper model not found at ${this.model}. See private/docs/HANDOVER.md for the download, or set POLYCAP_TRANSCRIBER=none.`);
    const args = ['-m', this.model, '-f', wav, '-oj', '-of', workPrefix, '-l', this.language, '-np'];
    // A call's track is quiet for long stretches, where whisper loops on the text before (the last
    // sentence repeated through a silence) and writes non-speech as words: no carried-over context, and
    // non-speech tokens suppressed (both in whisper.cpp 1.7 and later; 1.9.4 here, 2026-11-05).
    // Headset narration is left as it was. Lines said over silence are dropped after (silence.ts).
    if (options.call) args.push('-mc', '0', '-sns');
    if (this.threads > 0) args.push('-t', String(this.threads));
    await exec(this.bin, args, { timeoutMs: 60 * 60_000 });
    const parsed = parseWhisperJson(await readFile(`${workPrefix}.json`, 'utf8'));
    return { engine: this.kind, model: this.model, ...parsed };
  }
}

export class NoTranscriber implements Transcriber {
  readonly kind = 'none';
  describe() { return 'none (POLYCAP_TRANSCRIBER=none)'; }
  async transcribe(): Promise<Transcript> { return { engine: this.kind, segments: [] }; }
}

export function createTranscriber(config: Config): Transcriber {
  if (config.transcriber === 'none') return new NoTranscriber();
  if (config.transcriber === 'gladia') {
    if (!config.gladiaKey) throw new UserError('POLYCAP_TRANSCRIBER=gladia needs GLADIA_API_KEY');
    return new GladiaTranscriber(config.gladiaKey, config.gladiaUrl, config.language, { deleteJobs: config.gladiaDeleteJobs });
  }
  return new WhisperCppTranscriber(config.whisperBin, config.whisperModel, config.language, config.threads);
}

/** A warning for any transcript that is not plainly the narrator's microphone. */
export function voiceNote(voice?: Voice): string | undefined {
  if (voice === 'app') return "**Voice: the app's own sound.** No microphone was recorded, so these are the app's words (a voice-over, dialogue), not the user's.";
  if (voice === 'unknown') return "Voice: one mixed track; it may hold the app's sound as well as the user's.";
  if (voice === 'both') return "Voices: **Me** is the microphone, the person who recorded the call; **Others** is the call's sound, everyone else on it.";
  return undefined;
}

/** Words that often open a new thought, so a pause before one is a good place to break a line. */
const OPENERS = /^(let'?s|so|okay|ok|um|uh|erm|now|then|also|maybe|but|anyway|right|next|if|when|because)$/i;
/** Words a phrase does not end on, so a pause after one is hesitation, not a boundary. */
const CONTINUES = /^(and|or|but|the|a|an|of|to|with|in|on|for|at|from|by|into|is|are|was|were|be|we|i|you|they|my|our|your|very|really|kind|sort|some|let'?s|um|uh|erm)$/i;
const SENTENCE_END = /[.!?…]["'”’)\]]*$/;
const bare = (word: TranscriptWord) => word.text.replace(/[^A-Za-z']/g, '');

export interface SplitOptions { maxMs: number; minMs: number; minWords: number }

/**
 * Long stretches of speech become sentence-sized lines, so each request gets its own clock (one
 * Gladia segment of a design pass ran 17 s, unpunctuated, and held four requests). Only segments with
 * word timings are split: at sentence punctuation first, then, while a piece is longer than maxMs, at
 * the best-scoring gap between words: its pause, plus half a second before an opener ("let's", "so",
 * "um", "if") and minus a second after a word a phrase does not end on ("and", "the", "let's"), never
 * leaving a piece shorter than minMs or minWords. A segment the engine ended on such a word ("um
 * let's" | "keep the dials") is first joined to the next one. A split piece's text is its words; a
 * segment left whole keeps its own.
 */
export function splitLongSegments(segments: readonly TranscriptSegment[], options: SplitOptions = { maxMs: 8000, minMs: 1500, minWords: 3 }): TranscriptSegment[] {
  const joined: TranscriptSegment[] = [];
  for (const segment of segments) {
    const prev = joined.at(-1);
    const tail = prev?.words?.at(-1);
    if (prev && tail && segment.words?.length && CONTINUES.test(bare(tail)) && segment.startMs - prev.endMs < 1500) {
      joined[joined.length - 1] = { startMs: prev.startMs, endMs: segment.endMs, text: `${prev.text} ${segment.text}`, words: [...prev.words!, ...segment.words] };
    } else joined.push(segment);
  }
  const out: TranscriptSegment[] = [];
  for (const segment of joined) {
    const words = segment.words ?? [];
    if (words.length < 2) { out.push(segment); continue; }
    const sentences: TranscriptWord[][] = [[]];
    words.forEach((word, i) => {
      sentences.at(-1)!.push(word);
      if (SENTENCE_END.test(word.text) && i < words.length - 1) sentences.push([]);
    });
    const pieces = sentences.flatMap(sentence => cut(sentence, options));
    if (pieces.length === 1) { out.push(segment); continue; }
    pieces.forEach((piece, i) => out.push({
      startMs: i === 0 ? segment.startMs : piece[0].startMs,
      endMs: i === pieces.length - 1 ? segment.endMs : piece.at(-1)!.endMs,
      text: piece.map(w => w.text).join(' '),
      words: piece,
    }));
  }
  return out;
}

function cut(words: TranscriptWord[], options: SplitOptions): TranscriptWord[][] {
  const { maxMs, minMs, minWords } = options;
  if (words.length < 2 * minWords || words.at(-1)!.endMs - words[0].startMs <= maxMs) return [words];
  let best = -1, bestScore = Number.NEGATIVE_INFINITY;
  for (let i = minWords; i <= words.length - minWords; i++) {
    if (words[i - 1].endMs - words[0].startMs < minMs || words.at(-1)!.endMs - words[i].startMs < minMs) continue;
    const score = (words[i].startMs - words[i - 1].endMs) + (OPENERS.test(bare(words[i])) ? 500 : 0) - (CONTINUES.test(bare(words[i - 1])) ? 1000 : 0);
    if (score > bestScore) { best = i; bestScore = score; }
  }
  if (best < 0) return [words];
  return [...cut(words.slice(0, best), options), ...cut(words.slice(best), options)];
}

/** Human-readable transcript with a clock on every segment, the form an agent reads first. */
export function transcriptMarkdown(id: string, transcript: Pick<Transcript, 'segments' | 'language' | 'engine'>, durationMs?: number, voice?: Voice): string {
  const head = [`# Transcript: ${id}`, '', `Engine: ${transcript.engine}${transcript.language ? ` · Language: ${transcript.language}` : ''} · Segments: ${transcript.segments.length}${durationMs ? ` · Duration: ${formatClock(durationMs)}` : ''}`, ''];
  // A call's lines name their speaker, so only its two voices together need saying.
  const whose = voice !== 'both' && transcript.segments.some(s => s.speaker) ? undefined : voiceNote(voice);
  if (whose) head.push(whose, '');
  if (transcript.segments.some(s => s.name)) head.push("Names: an Others line is given the name on the tile Meet ringed as speaking through most of it (speakers.json); a line with no ring, or with more than one person ringed, stays Others.", '');
  if (!transcript.segments.length) head.push('_No speech was transcribed._');
  for (const s of transcript.segments) head.push(`[${formatClock(s.startMs)}] ${lineText(s)}`);
  return `${head.join('\n')}\n`;
}
