# Spatial messaging protocols and agent readability

Research date: 10 October 2026. This is a proposal, not a statement of implemented capabilities.
Reviewed official specifications and the current receiver, CLI, bundle pipeline, skill and router.
No private recordings were opened, no hosted receiver was contacted, and no product code was changed.
Two synthetic checks exercised existing pure functions; findings from other paths are source inspections.
**Corrected 12 October 2026:** the findings stand, but their weight and order changed; read
[Corrections](#corrections-12-october-2026) first. **Router removed 12 October 2026:** the local
router this note inspects (`src/router/`, `docs/ROUTER.md`) was taken out the same day in favour of
waiting in the posting conversation; its last version is in commit `43edcee`.

## Corrections, 12 October 2026

A review the next day re-checked these findings against the source and reproduced both synthetic
probes with the same inputs. Nothing below was found to be wrong. Correction 1 was understated, the
fixes proposed under corrections 2 and 3 needed changing, and the order of work changes.

1. **Readiness was a delivery bug, not only an inconsistency.** The router downloads through the
   strict sync (`syncReadyBundle`). The receiver marks a recording `ready` even when a step failed.
   Any failed step therefore failed the router's download, which counted it as a local preflight
   failure, retried twice and blocked with "check local setup". The likeliest triggers are the
   steps that call Anthropic, summary and pointing. **Implemented 2026-10-12:** a failed probe,
   audio, transcribe, frames or storyboard step blocks the delivery at once and names the steps. A
   failed summary, pointing or markers step is delivered, with the missing readings named in the
   task's `gaps` (`docs/ROUTER.md`, "Recordings with failed steps", commit `43edcee`). The wider
   proposal in section 5 below (evidence availability on the receiver API, revisions) is still a
   proposal.
2. **In request grounding, the bigger failure is that one bad request fails the whole step.**
   `cleanRequests` throws on the first malformed clock or request over 300 characters. The summary
   step then fails, and the recording loses its title and summary as well as its requests
   (reproduced). Validate each request on its own and drop or flag the invalid ones. Segment IDs
   alone only reject citations that point nowhere; a model can cite a real but wrong line just as
   easily. Ask for a verbatim quote and check it against the line it cites. Moving a clock before the
   first line onto that line is deliberate and tested. Moving a clock in a silent gap onto the
   previous line is not tested, and breaks the comment's rule that a request is pinned to the line
   spoken at that moment, since no line was spoken then. The
   prompt's "one short imperative sentence" is what loses the difference between a suggestion and an
   instruction; record a kind (change, problem, idea, question) instead. Do this after correction 1,
   because stricter validation produces more failed summary steps. **Implemented 2026-10-12**
   (`requests.json` version 2): the model names a line and quotes it, the quote decides the line,
   unmatched requests are rejected individually with reasons, and each has a kind. A live check on
   two synthetic transcripts the same day found every quote on its cited line and the hedges kept,
   where the previous prompt dropped them all (details in the roadmap's verification record); real
   recordings are still unmeasured.
3. **The joined view mostly exists already: `storyboard.md`.** It already puts requests beside their
   lines, with frames, pointing readings and the option on screen, and the skill sends agents there
   first. `show --json` does lack the transcript and pointing, but no current consumer reads it as
   the agent's view. A structured projection matters once a second consumer exists. It is not a
   first increment.
4. **Silent stretches really do lose frames; how much that matters is unknown.** Reproduced: a 60 s
   take with speech at 10–12 s and 30–32 s gets 4 frames, while the same take with no transcript
   gets 13. Narrated walkthroughs are mostly speech, so the cost on real recordings needs the
   evaluation. The roadmap's Phase 2 already lists scene-change frames. A cheap first step is to add
   interval frames, at the lowest priority, inside long gaps. **Implemented 2026-10-16:** the same
   take now gets 13 frames, 9 of them in silence; over the cap, silence frames give way first. The
   storyboard also marks pointing frames the pointing pass did not read. Scene-change frames and
   frames at app or option switches remain to do.
5. **Measure before building the view.** This note put evaluation last. It should come before the
   joined view, because it decides which of the remaining items matter. The roadmap's Phase 2 exit
   is nearly the same test. CAP-1 already holds agent-written request lists (#7, #10, #15, #22,
   #25). Once Robin has checked them, they can seed the labels.
6. **The open protocol is premature.** There is one user, one producer and one consumer, and the
   roadmap still lists the headset-to-next-build loop as unverified. A format with no second
   implementation is a spec nothing tests.
   - **JMAP:** for Polydance, borrowing from it comes down to a cursor saved per consumer, plus reads
     that do not mark anything as read, on the existing event feed.
   - **Email bridge:** it is for bringing in testers, which is Phase 4, and the roadmap requires the
     consent and retention design before that phase.
   - **Keep one cheap step now:** shape new request evidence after Web Annotation selectors (a
     text-quote selector and a media-fragment time range, with a region later), so exporting later
     is cheap.
   - **Adapters:** apply the rule [DESIGN.md](DESIGN.md) gives for MCP, that it "earns its place
     when a second host needs the bundles", to every adapter.

Revised order:

1. Router readiness (done 2026-10-12).
2. Per-request validation, verified quotes and request kind (done 2026-10-12).
3. A baseline evaluation on about ten existing recordings (requests done 2026-10-16 on 13; see the
   roadmap's verification record).
4. Sparse frames in silence, and a "not analysed" pointing state for frames past the 24 analysed
   (done 2026-10-16).
5. The JSON projection, reading only what changed, and the open format, decided against the
   evaluation results and an actual second consumer.

## Recommendation

Build a small open spatial-message format, an efficient retrieval/delivery API and adapters to existing
systems. Polydance's distinctive contract should preserve the connections between an experience,
its version, a person's response and the evidence supporting that response.

Borrow mature identity, threading, sync, retry and annotation conventions. Keep the first format
independent of the headset vendor, processing model, agent runtime and delivery transport. A useful
first interoperability test is a separate producer or reader that exchanges messages without using
Polydance's UI. Email delivery, an MCP integration and an A2A adapter can then reuse that format.

For the product promise, define agent readability as: an agent can identify the relevant experience,
retrieve the necessary evidence, distinguish observation from interpretation, and resume from changes
without rereading the whole conversation. This can be evaluated rather than asserted.

## What to borrow

| Reference | Existing mechanism | Proposed use in Polydance | Adoption boundary |
| --- | --- | --- | --- |
| [Internet Message Format, RFC 5322 §3.6.4](https://www.rfc-editor.org/rfc/rfc5322.html#section-3.6.4) | Message-ID, In-Reply-To and References identify messages and reply ancestry. | Give every message a globally unique identity and explicit parent relationships. Preserve email IDs separately when bridging. | Thread labels such as MUS-12 remain useful display names; they are insufficient across independent servers. |
| [MIME, RFC 2046 §5.1](https://www.rfc-editor.org/rfc/rfc2046.html#section-5.1) | Mixed parts bundle distinct content; alternative parts represent interchangeable versions. | Distinguish complementary evidence from alternative renditions. Send conventional text/HTML email previews, with richer content referenced or attached. | A lossy AI summary is not an interchangeable version of the full recording. Use ordinary MIME at the email boundary. |
| [JMAP Core, RFC 8620 §§2, 5–7](https://www.rfc-editor.org/rfc/rfc8620.html) | Capability discovery, property selection, batching, binary separation and state-based changes. | Fetch compact fields, then exact evidence; return changed/deleted objects and a resumable state token. | Borrow the sync design first. Full JMAP compliance needs separate work; JMAP is client/server sync, not server federation. |
| [Matrix Client-Server API](https://spec.matrix.org/latest/client-server-api/) | Typed events, explicit reply/thread relations and client transaction IDs for idempotent requests. | Represent replies, corrections, picks and reactions as explicit relationships; make posting retryable without duplicate messages. | Adopting Matrix wholesale also means implementing its room, sync and deployment model. Evaluate that separately from borrowing patterns. |
| [A2A specification §§3–4](https://a2a-protocol.org/latest/specification/) | Separate conversation contexts, tasks, messages, artifacts, typed content parts and negotiated extensions. | Keep a durable conversation distinct from an agent's task and its output. Advertise spatial-message capabilities and use a versioned extension in an adapter. | The client/server user/agent roles are not a complete identity model for a conversation with several humans and agents. A task lifecycle should not be compulsory for every message. |
| [W3C Web Annotation](https://www.w3.org/TR/annotation-model/) | Bodies describe targets; selectors locate media fragments, quoted text and regions; lifecycle metadata identifies creators/generators. | Link each extracted request to a transcript span and exact media moment. Add an optional region selector for a pointing target. | Reuse compatible selectors, but a screen region is not a 3D anchor. Native spatial anchors need a separate extension. |
| [CloudEvents](https://github.com/cloudevents/spec/blob/main/cloudevents/spec.md) | A transport-independent event envelope; source plus id identifies duplicates. | Wrap recording/annotation lifecycle events so external consumers can identify and filter them consistently. | CloudEvents does not provide a durable queue, acknowledgement, replay, ordering or exactly-once side effects. Those need an explicit delivery contract. |
| [ActivityPub](https://www.w3.org/TR/activitypub/) | Actor inbox/outbox delivery and recipient addressing over ActivityStreams objects. | A useful reference for provider-independent addressing if federation becomes necessary. | Recipient addressing is not a substitute for Polydance's access controls. Federating private recordings adds work beyond delivering invitations. |
| [MCP resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources) | Discoverable URI-addressed resources with MIME types, pagination and optional update subscriptions. | Expose exact thread/recording/evidence resources through an adapter using the same canonical representation as the CLI. | Resource notifications do not guarantee that an inactive agent conversation wakes. Keep delivery and host lifecycle contracts explicit. |

The highest immediate return is **Web Annotation for evidence grounding and JMAP for economical
reading**. Email conventions support the growth loop. Matrix informs reliable conversation semantics;
A2A and MCP are useful interoperability interfaces. CloudEvents helps external event consumers.
ActivityPub federation is a later decision.

## Current strengths

- Portable files: JSON manifests, transcript and frame indexes, plus a Markdown storyboard. Reading
  does not depend on the headset UI or a persistent agent process.
- Millisecond transcript/frame clocks, optional word timings, exact-frame retrieval and full-size
  pointing/reference frames.
- Context: source device, capture build, foreground app versions where available, thread association,
  answered message, launch choices and a timestamped launch log.
- Explicit processing step states and words-first delivery. Original media is retained separately
  from generated summaries and requests; the storyboard labels requests as a model interpretation.
- Voice attribution distinguishes microphone, app audio and an unknown mix. The summarizer suppresses
  user requests from app voice-over. This is an important foundation, although a microphone can still
  contain several speakers and speech recognition itself is an interpretation of the audio.
- The router already has durable ingestion, acknowledgement and idempotent publication machinery.
  This should inform ordinary integrations rather than be described as entirely missing.

## Improvements, in implementation order

### 1. Ground extracted requests with exact evidence

Today `requests.json` holds only `atMs` and paraphrased `text`, with the model recorded at file level
([schema](../src/session.ts), [extraction](../src/pipeline/summary.ts)). It has no request identity,
quoted source, span, evidence references or explicit modality such as suggestion/question/decision.
The prompt asks for imperative sentences, which can flatten tentative suggestions into commands.

Give transcript segments stable identities within a transcript revision. Ask the model for those
identities and source spans, then validate references deterministically. Store the original quote,
request kind, preserved qualification/negation, and supporting frame references separately from
the model's paraphrase. Where a request genuinely combines several statements, permit multiple
evidence references. Preserve review/correction and supersession relationships.

**Confirmed synthetic issue:** `cleanRequests` currently accepts clocks that do not identify a spoken
line and attaches them to the preceding line, or the first line if there is no preceding one. With
segments at 10–12s and 30–32s, both a supplied 00:00 and 00:22 attach to 10s. The function's comment
promises clocks outside the transcript are rejected, but this case is not rejected. This makes a
generated citation appear more grounded than it is. Replace clock guessing with exact segment IDs;
reject invalid references instead of silently moving them.

### 2. Add one joined, bounded agent view

`polycap show --json` returns a manifest, requests, markers and frames, but not transcript excerpts or
pointing results ([inspect command](../src/commands/inspect.ts)). The storyboard joins material for
Markdown readers, while machine consumers must perform their own joins.

Add a canonical structured projection containing: exact reply/experience references, readiness,
requests, original supporting quotes, selected frames, pointing interpretations, provenance and
unresolved questions. Render a compact Markdown equivalent from that projection. Keep existing
files as evidence rather than forcing every reader to reassemble them.

Use progressive disclosure: a small overview, relevant excerpts/frames, then exact media on demand.
Return explicit pagination/truncation and a continuation token; a budget must not silently hide
unseen requests. Separate optional model-generated thread summaries from the authoritative messages
they cite. CLI, HTTP and future MCP consumers should share these semantics.

### 3. Make pointing uncertainty and coverage visible

Pointing output currently contains a descriptive target and a model-generated `sure` boolean
([pointing](../src/pipeline/pointing.ts)). It lacks a region/object reference and does not explicitly
report why a target is unresolved. Only the first 24 candidate pointing frames are analysed; frame
planning can also discard candidates.

Add resolution states such as resolved, ambiguous, not visible and not analysed, with reasons and
evidence references. Store multiple candidates when necessary. Add a validated pixel/normalised
region when available, and optional stable object IDs from an instrumented application. Keep the
model, input revision and analysis time. A model's self-reported certainty is not a calibrated
probability; evaluate it before presenting numerical confidence.

Report analysed/omitted counts and the selection policy. Preserve the ability to inspect surrounding
frames or a short clip, since a single still can miss a gesture or ray movement. Native pose/anchor
extensions should specify units, coordinate frame, origin, timestamp and tracking validity when
those data actually exist. The present pointing bundle describes targets from images; it does not
establish shared 3D geometry.

### 4. Cover silent activity and qualify experience attribution

**Confirmed synthetic issue:** when any transcript exists, `planFrames` generates segment midpoints,
pointing-word candidates and edge frames, but no regular interval frames. A 60s recording with speech
only at 10–12s and 30–32s yields frames at 0.5s, 11s, 31s and 59.5s. Silent interactions can disappear
from the sampled view ([frame planner](../src/pipeline/frames.ts)).

Retain sparse coverage during silence, add frames around app/option transitions, and evaluate
scene-change or gesture-aware selection. Keep an explicit image budget while prioritising evidence
needed by requests. Pointing-word detection is currently English-specific; test other languages.

`onScreen` associates a timestamp with the last logged launch
([session helpers](../src/session.ts)). Treat that as launch evidence, with provenance, rather than
proof the intended page loaded and remained visible. Preserve machine-readable message/option IDs
even when repeated human-facing option labels are hidden. If app-switch or load evidence contradicts
the launch, surface uncertainty. Distinguish the capture app's build from the tested app/deployment.

### 5. Make readiness consistent and revisions explicit

The receiver marks an upload `ready` after the pipeline completes, even if steps failed
([worker](../src/server/worker.ts)). The strict completed-bundle sync rejects pending or failed steps
([sync validation](../src/commands/sync.ts)). The existing error/step fields expose failures, but
different consumers attach different meanings to ready.

Separate processing completion, available evidence and evidence quality. For example, expose
transcript/frames availability plus failed steps, and let a consumer state which evidence it needs.
A skipped optional pointing step need not block a textual reply; a failed transcript must not be
treated as usable narration. Retain conservative automation behavior until these requirements are
explicit, rather than simply relaxing validation.

Version evolving bundles and projections: words-only and full evidence share a recording identity
but have different evidence revisions. Existing file hashes provide integrity; add a stable revision
contract for citations, caches and change delivery. Retranscription or reanalysis creates a new
revision, with old evidence references either resolvable or explicitly invalidated.

### 6. Generalise durable change reading and retryable posting

Thread retrieval returns the whole message list; `thread show` also marks it read. `watch` starts at
the current event head unless `--after` is supplied and has no persistent consumer checkpoint
([thread command](../src/commands/thread.ts)). The skill compensates through reconciliation.

The router already separates durable processing state from read marks
(`src/router/store.ts`, commit `43edcee`). Expose that principle to simpler clients: side-effect-free reads,
bounded delta retrieval, receiver/account-scoped cursors, explicit retention-gap recovery and
acknowledgements separate from human read receipts. Keep event, message and bundle-revision IDs
distinct. Extend the existing receiver `deliveryId` support to ordinary CLI posting so retries can
reconcile one message receipt. Do not claim exactly-once external build operations from this alone.

### 7. Complete portable identity and extensibility

Messages have thread-local numeric IDs; only recordings have a reply relationship. Author data
separates a token, optional person and self-reported agent name, but does not provide an independent
stable agent identity ([message store](../src/server/threads.ts)).

Add globally scoped message identities and general reply/reference relationships. Keep authenticated
sender, on-behalf-of principal and display/model name separate. Model names should not be credentials.
Separate addressability (including an email address) from permission to view an existing thread.

Keep strict core validation, with a defined namespaced extension container and capability negotiation.
Unknown optional content can have a documented fallback; unknown required actions must fail clearly.
Do not weaken launch validation to accommodate arbitrary extensions. Treat transcript and incoming
content as evidence, with executable proposals subject to the existing authorization boundary.

## Proposed minimal contract

Use a small envelope with schema version, global message ID, thread ID, parent/reference IDs,
authenticated sender/on-behalf-of identities, creation time, text fallback, typed parts, evidence
revision and required/optional extensions. Keep large media separate, referenced by stable resource
identity, media type, size and digest; access URLs may expire independently of that identity.

Define annotations as records with their own identities, an interpretation/quote distinction,
typed targets/selectors, evidence references and generator/provenance information. Keep launches as
validated proposals to open an experience, linked to the exact version/option. Processing lifecycle
belongs to evidence; an agent task lifecycle is separate from the thread.

This is a proposed Polydance contract inspired by the sources above, not an assertion of compliance
with MIME, JMAP, Matrix, A2A, Web Annotation, CloudEvents, ActivityPub or MCP.

## How to substantiate “optimised for agent readability”

Build a consented evaluation set of representative recordings and exchanges. Include multiple
options in one take, delayed old-build feedback, silent interactions, ambiguous pointing, app
voice-over, microphone transcription errors, tentative and negated requests, corrections, missing
frames, words-first revisions, restart/retry and non-English narration. Synthetic fixtures can test
contracts, but actual target/evidence understanding needs real recordings and human labels.

Compare the same agents/tasks using raw media plus transcript, today's bundle and the proposed joined
view. Record request recall/precision, preservation of qualifications, correct build/option association,
supporting-citation validity, pointing accuracy and abstention quality, tokens/images/tool calls and
latency. Evaluate incremental reads and duplicate effects separately from perceptual understanding.

Predefine product acceptance thresholds after a baseline. Do not invent a savings percentage before
measurement. A credible near-term claim is “structured transcripts, visual evidence and conversation
context for agents.” A stronger demonstrated claim would be “agents retrieve the right evidence and
continue the right conversation with fewer calls and fewer attribution errors.”

## Suggested first increment

*Superseded by the revised order in [Corrections](#corrections-12-october-2026).*

Implement exact request evidence references, the joined JSON/Markdown view and consistent readiness
first. Add sparse silent-activity coverage and explicit pointing ambiguity alongside that evidence
work. Then generalise delta reading/retry semantics from the router. Publish the smallest open format
that another implementation can round-trip; add email, MCP or A2A adapters against demonstrated needs.

Validation performed for this research: source inspection and a local synthetic probe of
`cleanRequests` and `planFrames`. No model calls, hardware tests, live delivery tests or performance
benchmark were run; the full project test suite was not run because only this research note changed.
