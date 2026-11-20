import { z } from 'zod';
import type { Mark } from '../call.js';
import type { TranscriptSegment } from './transcribe.js';
import { lineText } from './voices.js';

export const MARKER_KINDS = ['bug', 'reference', 'idea', 'change', 'note', 'praise'] as const;
export type MarkerKind = typeof MARKER_KINDS[number];
export const markerSchema = z.strictObject({ atMs: z.number().int().nonnegative(), endMs: z.number().int().nonnegative(), kind: z.enum(MARKER_KINDS), cue: z.string(), text: z.string() });
export const markersFileSchema = z.strictObject({ version: z.literal(1), markers: z.array(markerSchema) });
export type Marker = z.infer<typeof markerSchema>;

/**
 * The narrator showing something to copy: "copy this", "kind of like these", "this kind of design".
 * The frames step keeps a full-resolution frame of these moments, because a reference shown in the
 * headset browser was otherwise only seen at 1024 px (design passes 2 and 3, 2026-10-01).
 */
export const REFERENCE_CUE = /\b(copy(?:ing)? (?:this|these|that|those|it|the)|(?:kind of|sort of|something|just|exactly) like (?:this|these|that|those)|like (?:this|these|that|those) (?:one|ones|design|style|look|layout|colou?rs?|buttons?)|(?:this|that|these|those) (?:kind|sort|style|type) of (?:design|look|layout|style|thing|interface)|reference|inspiration)\b/i;

/**
 * Spoken cue words stand in for in-app upvote and bug buttons. Priority order: a sentence with "bug" is
 * a bug even if it also says "nice", and a reference outranks the directive around it. `change` catches
 * design directives ("we don't need this", "let's hide", "simplify"), which a design pass is made of
 * and which no other cue matched (2026-10-01).
 */
export const CUES: ReadonlyArray<{ kind: MarkerKind; pattern: RegExp }> = [
  { kind: 'bug', pattern: /\b(bug|bugs|broken|crash(?:es|ed|ing)?|glitch(?:es|y)?|doesn'?t work|does not work|not working|isn'?t working|fix (?:this|that|it)|wrong)\b/i },
  { kind: 'reference', pattern: REFERENCE_CUE },
  { kind: 'idea', pattern: /\b(idea|what if|(?:it )?would be (?:nice|good|great|cool|better)|feature request|should (?:be able to|have|let)|could we|suggestion)\b/i },
  { kind: 'change', pattern: /\b(we don'?t need|don'?t need (?:this|that|these|those|it)|get rid of|(?:hide|remove) (?:this|that|these|those|it|all)|simplif(?:y|ied)|let'?s (?:hide|remove|move|change|centre|center|make|simplify|add|keep|put|drop)|make (?:it|this|that) (?:look )?(?:better|bigger|smaller|simpler|clearer|cleaner))\b/i },
  { kind: 'note', pattern: /\b(note|todo|to-do|remember|important|take note|flag this)\b/i },
  { kind: 'praise', pattern: /\b(love (?:this|it|that)|really (?:nice|good|cool)|works well|great|awesome|perfect)\b/i },
];

/**
 * A call's spoken cues, said on purpose to mark a moment (docs/MAC.md P6), and only these: in
 * conversation "great", "wrong" or "remember when" are talk, not markers. The pipeline looks for them
 * on Me's lines only, since Others did not ask for anything to be marked.
 */
export const CALL_CUES: typeof CUES = [
  { kind: 'note', pattern: /\b(action items?|note that|take (?:a )?note|make a note|flag (?:this|that)|mark (?:this|that)|to-?do)\b/i },
];

export function findMarkers(segments: readonly TranscriptSegment[], cues: typeof CUES = CUES): Marker[] {
  const markers: Marker[] = [];
  for (const s of segments) {
    for (const cue of cues) {
      const match = s.text.match(cue.pattern);
      if (!match) continue;
      markers.push({ atMs: s.startMs, endMs: s.endMs, kind: cue.kind, cue: match[1].toLowerCase(), text: s.text });
      break;
    }
  }
  return markers;
}

/** The cue a mark's marker carries, so a mark is never mistaken for a spoken one. */
export const MARK_CUE = 'mark';

/** The line being said at atMs: the latest-starting one that spans it, else the last to end in the 10 s before it. */
function lineAt(segments: readonly TranscriptSegment[], atMs: number): TranscriptSegment | undefined {
  const spanning = segments.filter(s => s.startMs <= atMs && s.endMs >= atMs);
  if (spanning.length) return spanning.at(-1);
  return segments.filter(s => s.endMs < atMs && atMs - s.endMs <= 10_000).at(-1);
}

/**
 * The user's marks (C7) as markers of kind note, cue "mark": the note typed with it, or else the line
 * being said at that moment, with its speaker in a call. Clocks past the end are held to it.
 */
export function markMarkers(marks: readonly Mark[], segments: readonly TranscriptSegment[], durationMs?: number): Marker[] {
  const last = durationMs ? Math.max(0, durationMs - 1) : Number.MAX_SAFE_INTEGER;
  return marks.map(mark => {
    const atMs = Math.min(mark.atMs, last);
    const line = lineAt(segments, atMs);
    return { atMs, endMs: atMs, kind: 'note' as const, cue: MARK_CUE, text: mark.note ?? (line ? lineText(line) : 'marked; nothing was being said') };
  });
}
