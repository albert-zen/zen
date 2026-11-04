# Proposed system-assigned question numbers

Status: contract draft only. No production implementation is included in this
checkpoint. The existing requirement to commit every model-visible string before
adapter dispatch remains in force. The representation decision below must be
resolved before changing that boundary.

## Observable contract

- A Thread assigns `Q1`, `Q2`, and so on to individual questions. A successful
  publication containing three questions receives three consecutive numbers in
  authored order; the next publication starts at `Q4`. These are not tool-call
  numbers, generic Item sequence numbers, or model-supplied IDs.
- Allocate by the durable order in which a complete, accepted semantic call/result
  pair first exists. Parallel bodies completing out of order cannot change an
  already published assignment. Invalid, failed, unpublished and non-question
  calls consume no numbers. A duplicate receipt cannot allocate again.
- Answers and cancellation use the exact numbers reported for that publication.
  Cancellation, recall and completed answers do not recycle numbers. Reconnect,
  cold reconstruction and context selection/compaction do not renumber history.
- Forks preserve inherited display numbers and continue after the inherited
  prefix. A copied number does not make a parent's question answerable in the
  child. Imported display history likewise cannot acquire native response
  authority merely by containing question-shaped text.
- The model-facing publication body and generated reply wrapper contain no native
  Thread, call Item, response-client or transport UUID. Native APIs and trusted
  provenance retain exact UUIDs for routing, deduplication and recovery. A `Qn`
  label never grants permission and is not a native response address.

## Input and binding compatibility

- New tool calls require question text, not a question number. Question IDs and
  option IDs become optional binding keys. Omitted keys receive deterministic,
  call-local keys after reserving all explicit sibling keys, including later
  siblings. Each question has its own option-key namespace.
- Existing explicit question/option IDs retain their meaning. They remain local
  answer/template bindings, not the system's Thread-wide display numbering.
- Explicit `answerTemplate` strings retain their byte and substitution semantics:
  every local question key occurs once, option labels remain in authored order,
  and free text is literal. Do not silently rebind a template to `Qn` labels or
  reinterpret braces in user text.
- Without an explicit template, model-facing answers are labelled with assigned
  `Qn` numbers. With a template, the generated wrapper identifies the assigned
  questions while the template's rendered answer remains intact.
- Ordinary user text, quoted UUIDs, prompts, option labels, free-text answers and
  custom templates are not subject to generic UUID removal or replacement.

## Persistence and representation decision

Existing source facts remain immutable. Recognition is structural, not a regular
expression over text:

1. Resolve an actual `ask_user_question` semantic call and its successful,
   completed result by exact Turn/provider-call pairing.
2. Validate the publication envelope against the exact native Thread and call
   Item identity. Missing calls can become complete only when their actual
   semantic call is appended/repaired; an earlier source ordinal alone does not
   reserve a visible number.
3. For a human reply, require native `questionReply` provenance, resolve its exact
   request and normalize its answers against the original specification. Require
   the complete body to equal a recognized historical renderer, including its
   outcome and literal answer bytes. Plain text and forged mismatches do not
   consume or answer a question.
4. Keep old canonical receipt/reply bytes readable without reopening completed
   questions or rewriting history. Exact retries retain their original bytes.

Two representations are under review:

- Persist typed display overlays in the existing semantic ItemList, analogous to
  image preparation. They contain the exact model-facing strings and links to
  their original sources. The compiler selects them at the original positions;
  originals and native authority remain unchanged. This preserves the current
  commit-before-dispatch invariant and introduces no question store or mutable
  counter authority.
- A pure final-compiler display projection would be smaller, but it is an explicit
  change to today's selection-only compiler contract. It must not be introduced
  silently or described as already authorized by the current architecture.

The first representation is the default proposal while that decision is pending.
Do not create a separate durable registry, allocate by generic source sequence,
reconstruct execution capability from display labels, or modify unrelated image
preparation behavior.

`ask_user_question` can also publish independent Room resources. Those answers
arrive under the Room's existing authority and delivery policy, not as native
Thread question replies. The Room scope and its currently model-visible resource
identifiers must be decided explicitly rather than treating a Thread-wide number
as a cross-Thread Room address.

## Upstream findings

These numbers are a proposed Zen contract, not an existing upstream guarantee.

At Codex `d84c872464aca4821dc5cb548a651651aefd84fa`:

- Synchronous `request_user_input` requires a model-authored snake_case question
  ID. Its successful result maps answers by that ID and does not add a transport
  call UUID. See the [specification](https://github.com/openai/codex/blob/d84c872464aca4821dc5cb548a651651aefd84fa/codex-rs/core/src/tools/handlers/request_user_input_spec.rs)
  and [handler](https://github.com/openai/codex/blob/d84c872464aca4821dc5cb548a651651aefd84fa/codex-rs/core/src/tools/handlers/request_user_input.rs).
- The separate asynchronous tool takes question titles/options and immediately
  returns `accepted: true`. Its later answer fragment includes a composite
  question-item identity; it does not assign continuous Thread-wide `Qn` labels.
  See the [async handler](https://github.com/openai/codex/blob/d84c872464aca4821dc5cb548a651651aefd84fa/codex-rs/core/src/tools/handlers/request_user_input_async.rs),
  [client state](https://github.com/openai/codex/blob/d84c872464aca4821dc5cb548a651651aefd84fa/codex-rs/tui/src/bottom_pane/async_questions/state.rs)
  and [answer fragment](https://github.com/openai/codex/blob/d84c872464aca4821dc5cb548a651651aefd84fa/codex-rs/context-fragments/src/answered_question.rs).

At T3 Code `3368dd70f20cb192b68895494a4a73455524fb76`, the Codex adapter
preserves synchronous provider question IDs, with a batch-local fallback when
missing; app request identity and native callback identity are separate. Async
questions use batch-local indices. Neither is a Thread-wide continuous question
number. See the [adapter](https://github.com/pingdotgg/t3code/blob/3368dd70f20cb192b68895494a4a73455524fb76/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts)
and [answer builder](https://github.com/pingdotgg/t3code/blob/3368dd70f20cb192b68895494a4a73455524fb76/packages/client-runtime/src/state/pendingUserInput.ts).

## Required acceptance

Use actual Host/compiler requests and cold persisted replay, not only string
matching: multi-question/multi-call numbering; out-of-order parallel bodies and
answers; invalid/failed/duplicate publications; cancellation/recall/retry;
reconnection; fork/import; context compaction; omitted/explicit binding collisions;
custom templates/options; old ID/key-only/previous numbered histories; wrong
number/key/body/outcome or missing provenance; literal human UUIDs unchanged.
Existing no-question/hot-read projection-cost assertions remain intact. Evidence
must bind to the final source tree; old candidate CI is not new-code acceptance.
