# Compaction trigger and visibility audit (#573)

## What the source proves

The sole context compiler **does not decide to compact, generate a summary, or
retry a request**. `src/item-list.ts:compileItemList` selects already-persisted
semantic Items; `src/context-preparation.ts` materializes model-visible inputs
before that compiler. Actual reset admission belongs to `ZenAppServer` or the
agentic tool path in `AgentRuntime`.

A model's prose saying “the Host automatically ran compact_context” is not an
execution receipt. In particular, the `cN` list from
`src/builtin-model-handles.ts:builtinCompactionReferences` is published whenever
that sample exposes the optional tool. It describes retention choices; its
presence alone neither executes nor proves compaction. The wording now says so.

No real private Thread/Trace/configuration was inspected for this audit. The
reported individual incident's actual trigger and configured window therefore
remain unverified. Reproduction and verification use synthetic adapters/events,
not paid model calls or real-history compaction.

## All initiating paths

| Path                       | Actual condition / boundary                                                                                                                                                                                                                                                                                                       | Source                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Explicit request           | `compactThread` / `thread/compact`; no active/incomplete Turn, newest eligible completed boundary, not already covered. The persisted enum `human` means this explicit endpoint, not verified physical human action.                                                                                                              | `src/app-server.ts:compactThread`; `src/protocol/codex/connection.ts`          |
| Agent-authored             | Experimental `agenticEnabled` defaults false. The model emits one standalone top-level `compact_context`; its supplied text and bounded retention are validated and committed before continuing the same Turn. No separate summary-provider call.                                                                                 | `src/runtime.ts:#prepareAgenticContextCompaction`; `src/context-compaction.ts` |
| Host after successful Turn | Highest valid Provider input usage in the current usage epoch reaches `ceil(contextWindow * triggerPercent / 100)`. Default trigger is 80%. Missing/invalid usage does not trigger this path.                                                                                                                                     | `src/app-server.ts:#commitFinalResponse`, `#compactCompletedTurnAutomatically` |
| Host before next Turn      | Estimate of the full prospective input, including pending user input, reaches the same trigger and there is an uncovered completed boundary. This is awaited **before input admission / send ACK**. It is not restricted to missing-usage cases.                                                                                  | `src/app-server.ts:#compactBeforeTurnIfNeeded`, `#launchTurn`                  |
| Host between tool rounds   | Uses the greater of Provider input usage and the next complete projection estimate (including newly appended results). Agentic off: automatic at trigger. Agentic on: model reminder at trigger, Host fallback at `min(100, max(trigger, min(99, trigger + 15)))` percent; default 95%. Only completed history can be summarized. | `src/app-server.ts:#handleActiveTurnCompaction`                                |
| Fork / side chat           | Creation copies history / existing selection; it does **not** invoke summary generation. The child's later first Send can independently hit pre-Turn automatic compaction.                                                                                                                                                        | `src/app-server.ts:forkThread`, `createChildThread`, `#launchTurn`             |
| Context overflow / retry   | A rejected provider request is not an automatic compaction trigger. Deterministic admission errors do not become compaction retries. Active-Turn post-tool admission can compact **before** a request; that is distinct from replaying a failed one.                                                                              | `src/loop-recovery.ts`; `src/runtime.ts`; compaction tests                     |

A first active Turn without completed history cannot use Host-generated
compaction; a full/oversized input fails explicitly rather than silently dropping
context. An immediately preceding successful agentic reset invalidates old usage
so it does not cause an immediate duplicate Host reset.

Turning the Agentic switch off **does not disable Host automatic compaction**.
This patch does not change that policy, default thresholds, or retention rules.
Whether to add an automatic-compaction opt-out/approval mode is a separate product
decision, not an undocumented change in this fix.

## Window and measurement provenance

Runtime selection takes the currently configured catalog window. Core
`src/provider-registry.ts` rejects a missing window with `context_window_unknown`;
`src/model-catalog.ts` defaults absent metadata to null, not a guessed size.
ZenX `host-profile.ts:providerRuntimeCatalog` copies configured model metadata.
Compatible model discovery leaves unknown windows null; an exact built-in preset
can supply known metadata. Subscription discovery can use provider-declared
`context_window`, then an exact preset. The model's name alone does not establish
its configured or provider-enforced limit.

Completed-Turn automatic generation freezes the **current selection when the
auxiliary sample is admitted**, not an obsolete original-Turn setting. The
original turn's reported usage remains an observation from that turn; the record
contains the resolved window/selection used for this decision. Trigger evidence
now keeps reported input and estimated input separate, alongside threshold,
window, trigger/target percentages and Agentic mode.

## Confirmed visibility gaps and fixes

- Before: `cN` capability text could be mistaken for a reset receipt. Now it
  explicitly says optional references are not a compaction event.
- Before: reset model text had only `[Zen compacted context]`. New generated v4 /
  agentic v3 selections identify the committed initiator, distinguish continuation
  from a new user request, and explain omitted-history access. The summary is
  unchanged, the notice is budgeted and persisted before compilation, and old
  algorithm versions keep their exact text.
- Before: Host-generated compaction had no shared pending notification; completed
  Turn failure could be only a Host warning. Native `context_compaction_status`
  now carries exact Thread/operation identity, trigger evidence, pending and
  committed/failed/cancelled/unknown outcomes. Existing composer feedback renders
  it, including a side-chat child waiting for first input admission.
- Success still comes from the committed canonical selection. Failed/unknown
  observations never synthesize a success card or change a completed Turn to
  failed. Connection loss retires pending feedback to unknown; no automatic
  replay occurs. Exact epoch/watermark/operation fences reject stale feedback.
  Recovery requires the exact committed Item or a new matching selection after
  the canonical prefix captured at operation start; an old reset of the same
  boundary cannot erase new pending, failed or unknown feedback. Manual request
  identity is independent of feedback and preserves exact draft/revision guards.
- Generated compaction now rejects non-advancing boundaries before summary
  generation. A newer agentic reset cannot make Host fallback summarize an
  already-superseded completed prefix; the model receives an explicit no-new-
  completed-history notice while still within the configured window.
- Settings previously claimed compaction never ran within an unfinished Turn;
  this contradicted the active-tool-round path. Settings now show all three Host
  timings and the current configured trigger/fallback formula, without adding or
  changing a switch.
- Trace now records `context_compaction_started`, linked
  `context_compaction_sample` observations, and `context_compaction_finished` with
  elapsed local time and committed/failed/cancelled/unknown outcome. The source
  Thread links each auxiliary owner/sample; auxiliary request configuration links
  back. Use the existing **events** view for these Thread observations. Missing
  Trace is not proof that no compaction ran.

These are the same three domains: semantic ItemList for model contents and
selection; Trace for observed causes/timing/results; existing transient UI product
state for feedback. No execution ledger, adapter-side trimming, new hidden
summary, policy retry, or permission change is introduced. CAS does not receive
fabricated mappings for the new native observation.

## Verification / review fixture

Core synthetic tests cover the five generated admission causes, exact commit
ordering, failure and unknown append outcomes, source-to-auxiliary correlation,
old-version text, current model notice, selection/replay/retention and active
boundaries. Renderer tests cover all feedback outcomes, stale operation/epoch /
watermark rejection, disconnect/canonical reconciliation, no premature success,
readable escaped errors, real synthetic Host manual requests with live status
and canonical refresh, draft edit/reply races, old-boundary feedback, and the
existing summary views. Hosted tests run from
`apps/zenx`, not the repository root.

Build the production-component, offline synthetic review document:

```sh
node apps/zenx/scripts/build-compaction-trigger-preview.mjs /tmp/compaction-preview
```

Open `compaction-trigger.html`; `source.json` records source commit, dirty state,
source hashes and bundle hash. Visible controls select each phase/cause,
English/Chinese, light/dark, 390px/wide and the real settings panel. Check pending
before new input admission (no agent-work timer), known failure vs unknown,
keyboard error disclosure/dismiss, committed summary disclosure, and settings.
No Host, real history, model, network or native desktop actions are performed.
Building the fixture and passing JSDOM tests do not claim visual acceptance;
matching real browser screenshots are still required before merge.
