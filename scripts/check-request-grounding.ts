/**
 * A live check of the summary step's requests, not a test: it calls Anthropic (two calls per run,
 * Haiku by default, POLYCAP_SUMMARY_MODEL to change) with two synthetic, hand-labelled transcripts and
 * reports how many requests were grounded, moved or rejected, which labelled requests were found, and
 * whether hedges and negations survived the paraphrase. Nothing private is sent. Run it after changing
 * the summary prompt: `npx tsx scripts/check-request-grounding.ts [runs]`. Needs ANTHROPIC_API_KEY in
 * ~/.config/polycap/env or the environment. Results from 2026-10-12 are in private/docs/ROADMAP.md.
 */
import { loadConfig, readEnvFile, userConfigFile } from '../src/config.js';
import { summarize } from '../src/pipeline/summary.js';
import type { TranscriptSegment } from '../src/pipeline/transcribe.js';

/** Sentence-sized lines a little apart, with an optional long silence after one line. */
function lines(texts: string[], silenceAfter?: number): TranscriptSegment[] {
  let t = 2000;
  return texts.map((text, i) => {
    const segment = { startMs: t, endMs: t + 2000 + text.length * 45, text };
    t = segment.endMs + 400 + (silenceAfter === i + 1 ? 40_000 : 0);
    return segment;
  });
}

/** One labelled request: its line (and lines it may run on to), acceptable kinds, and what must survive. */
interface Label { line: number; also?: number[]; kinds: string[]; gist: string; hedge?: boolean; negation?: RegExp; optional?: boolean }

const TRANSCRIPTS: { name: string; segments: TranscriptSegment[]; labels: Label[] }[] = [{
  name: 'deck design pass: punctuated, American spelling, 40 s of silence after line 12',
  segments: lines([
    'Okay so this is the new deck on the latest build.', 'The reels look really good now, I love how they spin up.',
    'But the counter is way too small, I can barely read it.', 'Make the counter bigger and maybe put it in the middle.',
    'Um, let me try the inbox.', 'So when I press this the inbox opens on the right.', 'It takes like two seconds to open which feels slow.',
    'Could we have it open instantly, or at least show something', "while it's loading.",
    "Don't change the color of the star though, that's perfect.", 'What does the funnel icon do?', "I'm not sure if it's filtering or sorting.",
    'Okay, back to the deck.', "The record button should be red when it's recording, not orange.",
    'And the delete button is too close to send now, I keep hitting delete by mistake.', 'Move delete further away from send.',
    'It would be nice if the recording list showed how long each one is.', 'Hmm, I wonder if we even need the storage readout.',
    "Yeah, I think that's it for now.",
  ], 12),
  labels: [
    { line: 3, kinds: ['problem'], gist: 'counter too small' },
    { line: 4, kinds: ['change'], gist: 'counter bigger, maybe in the middle', hedge: true },
    { line: 7, kinds: ['problem'], gist: 'inbox slow to open' },
    { line: 8, also: [9], kinds: ['idea', 'change'], gist: 'open instantly or show loading', hedge: true },
    { line: 10, kinds: ['change'], gist: "don't change the star's colour", negation: /don.?t|keep|leave|not/i },
    { line: 11, also: [12], kinds: ['question'], gist: 'what does the funnel do' },
    { line: 14, kinds: ['change'], gist: 'record button red, not orange', negation: /not|instead|rather/i },
    { line: 15, kinds: ['problem'], gist: 'delete too close to send' },
    { line: 16, kinds: ['change'], gist: 'move delete away from send' },
    { line: 17, kinds: ['idea'], gist: 'show recording lengths', hedge: true },
    { line: 18, kinds: ['idea', 'question'], gist: 'maybe drop the storage readout', hedge: true, optional: true },
  ],
}, {
  name: 'drum lesson: Gladia-style, lower case, no punctuation',
  segments: lines([
    "alright so i'm in the drum circle lesson", "the teacher's voice is a bit quiet compared to the drums",
    'can you turn the voice up or the drums down', 'um so when i hit this one here the stick goes through the drum',
    'yeah it clips right through', "that's a bug", 'i really like the lighting in here',
    'maybe the next exercise could unlock without me having to finish this one', 'is there a way to restart just the last bar',
    'not the whole lesson just the bar', 'and the score at the top is covering the drum on the left', 'so move it up a bit',
    "okay that's everything",
  ]),
  labels: [
    { line: 2, kinds: ['problem'], gist: 'teacher voice quiet' },
    { line: 3, kinds: ['change', 'question'], gist: 'voice up or drums down' },
    { line: 4, also: [5, 6], kinds: ['problem'], gist: 'stick goes through the drum' },
    { line: 8, kinds: ['idea'], gist: 'unlock the next exercise early', hedge: true },
    { line: 9, also: [10], kinds: ['question', 'idea', 'change'], gist: 'restart just the last bar', negation: /not|only|just/i },
    { line: 11, kinds: ['problem'], gist: 'score covers the left drum' },
    { line: 12, kinds: ['change'], gist: 'move the score up' },
  ],
}];

const HEDGE = /\b(maybe|could|might|perhaps|consider|would be nice|possibly|whether)\b/i;
const runs = Number(process.argv[2] ?? 3);
const config = loadConfig({ ...readEnvFile(userConfigFile()), ...process.env, POLYCAP_SUMMARIZER: 'claude' });
const total = { requests: 0, moved: 0, rejected: 0, labels: 0, found: 0, kindOk: 0, hedges: 0, hedgesKept: 0, negations: 0, negationsKept: 0, extras: 0, failed: 0 };

for (const t of TRANSCRIPTS) {
  for (let run = 1; run <= runs; run++) {
    let result: Awaited<ReturnType<typeof summarize>>;
    try { result = await summarize(config, t.segments); }
    catch (error) { total.failed++; console.log(`\n${t.name}, run ${run}: FAILED ${(error as Error).message}`); continue; }
    const accepted = result.requests.map(r => ({ ...r, line: t.segments.findIndex(s => s.startMs === r.atMs) + 1 }));
    Object.assign(total, { requests: total.requests + accepted.length, moved: total.moved + result.moved, rejected: total.rejected + result.rejected.length });
    console.log(`\n${t.name}, run ${run}: "${result.summary.title}"; ${accepted.length} kept, ${result.moved} moved, ${result.rejected.length} rejected`);
    for (const r of accepted) console.log(`  L${r.line} ${r.kind}: ${r.text}  «${r.quote}»`);
    for (const r of result.rejected) console.log(`  rejected L${r.line} ${r.kind}: ${r.text}  «${r.quote}», ${r.reason}`);
    // Each label takes the first unused request on its lines, preferring one of an acceptable kind.
    const used = new Set<number>();
    for (const l of t.labels) {
      const on = (i: number) => !used.has(i) && [l.line, ...l.also ?? []].includes(accepted[i].line);
      let i = accepted.findIndex((r, n) => on(n) && l.kinds.includes(r.kind));
      if (i < 0) i = accepted.findIndex((_, n) => on(n));
      const r = i >= 0 ? accepted[i] : undefined;
      if (r) used.add(i);
      if (!l.optional) { total.labels++; total.found += r ? 1 : 0; total.kindOk += r && l.kinds.includes(r.kind) ? 1 : 0; }
      if (r && l.hedge && !l.optional) { total.hedges++; total.hedgesKept += HEDGE.test(r.text) ? 1 : 0; }
      if (r && l.negation) { total.negations++; total.negationsKept += l.negation.test(r.text) ? 1 : 0; }
      const notes = [r && !l.kinds.includes(r.kind) ? `kind ${r.kind}` : '', r && l.hedge && !HEDGE.test(r.text) ? 'hedge lost' : '', r && l.negation && !l.negation.test(r.text) ? 'negation lost' : ''].filter(Boolean);
      if (!r || notes.length) console.log(`  label ${r ? 'found' : l.optional ? 'optional, not found' : 'MISSED'}: ${l.gist}${notes.length ? ` (${notes.join(', ')})` : ''}`);
    }
    total.extras += accepted.length - used.size;
    for (const [n, r] of accepted.entries()) if (!used.has(n)) console.log(`  extra L${r.line} ${r.kind}: ${r.text}`);
  }
}
console.log(`\n${config.summaryModel}, ${runs} runs each: ${total.requests} requests kept, ${total.moved} moved, ${total.rejected} rejected, ${total.failed} calls failed`);
console.log(`labelled requests found ${total.found}/${total.labels} (right kind ${total.kindOk}); hedges kept ${total.hedgesKept}/${total.hedges}; negations kept ${total.negationsKept}/${total.negations}; extras ${total.extras}`);
