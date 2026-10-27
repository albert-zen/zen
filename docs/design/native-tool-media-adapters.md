# Native tool media: adapter evidence boundary

This restores #500's independent contract into the current ItemList/Trace model.
It is not a production capability rollout. No live provider requests are needed
for this change; synthetic fixtures prove our encoding, not provider acceptance.

## Ownership and selection

Canonical tool results retain their text, modelContent and call identity. Native
transport representation belongs to the adapter, not tools, runtime or ItemList.
The Host injects the adapter-owned reviewed registry. A declaration must match the
fully resolved endpoint, exact model and protocol, and cover every media kind in
one result. Ordinary inputModalities, provider labels, model-name substrings and
another endpoint's successful request cannot substitute for evidence.

The native Chat registry is **deliberately empty**. Two exact targets retain
conflicting-documentation records; conflict takes precedence even over a supplied
native declaration. Other targets remain unknown. No persistent setting, probing,
automatic alternate-format retry or inferred durable capability state is added.

For calls A and B with an image in A:

- Native: assistant(A,B), tool A [receipt, caption, image], tool B.
- Compatibility: assistant(A,B), tool A text, tool B text, user [caption, image].

All replies remain contiguous before compatibility supplements. Content parts,
call association, media ordering and rejected-media attribution are preserved.
Nested calls inside run_code still produce one top-level result, not a new batch.
The canonical media vocabulary remains image/audio; no file variant is added.

## Durable observations, not model content

The existing always-on `ModelTransportObservation` request event carries an
optional `toolMediaTransport` metadata object with six bounded counts:

- `nativeToolContent`
- `compatibilitySupplement`
- `unknownTarget`
- `undeclaredMedia`
- `nativeSupportUnverified`
- `conflictingEvidence`

Counts describe tool results, not tokens, bytes or attachment parts. Only these
six nonnegative integer fields are captured, capped at 1,000,000. The snapshot is
taken before observers run and attached to the exact attempt. They never enter
the serialized request body or semantic ItemList. Declaration URLs/evidence text
are not copied into this summary. Ordinary Trace request metadata retains its
existing exact-URL policy; this is not broader Trace redaction.

`trace-model` persists the existing request event; the debugger projects its
counts from that same durable record after restart. No opt-in RAM buffer, capture
toggle, second authority or new renderer UI is introduced. Absent legacy
metadata remains absent rather than a fabricated all-zero observation. The
read projection also allowlists counts before returning summaries.

Subscription media retains compatibility supplements and reports native support
as unverified. Optional public API-key Responses is independent: its native
function_call_output images do not authorize Chat/subscription capabilities.
This restoration does not change Responses wire encoding or claim Responses
audio support. It does not add #500 diagnostics to the public Responses path.

## Reviewed conflicting evidence

Rechecked 2026-10-27; registry entries preserve their original review date
2026-10-25 and exact scope, rather than silently extending them to new endpoints.

- `https://api.deepseek.com/chat/completions` + `deepseek-flash`: the
  [Chat schema](https://api-docs.deepseek.com/api/create-chat-completion/) permits
  tool image arrays, while the [Vision restrictions](https://api-docs.deepseek.com/guides/vision/)
  say images are user-message-only. No hosted DashScope model, alias, v4-pro,
  audio or file capability follows from this record.
- `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` +
  `qwen3-vl-plus`: [Function Calling step 5](https://help.aliyun.com/en/model-studio/qwen-function-calling)
  permits image arrays but the [Chat Tool Message schema](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-chat-completions)
  requires strings. The legacy Beijing domain remains documented as functional;
  newer workspace-specific domains are not implicitly the same reviewed target.

Enabling native Chat later requires authoritative clarification or separately
authorized bounded contract tests for the exact account/endpoint/model and spend
cap. The implementation and synthetic tests confer no such authority. Empty
native capability activation does not depend on merging/selecting Responses.

## Acceptance

Tests exercise native/fallback/conflict/undeclared decisions, full tool batches,
subscription unverified-native status, independent Responses output, original
semantics/wire bytes and cold durable debugger projection. Host tests construct
the real factory, run a synthetic tool and fake fetch, close Host, then inspect
the persisted request with a new reader. They prove no provider capability and
perform no user-computer action, external tool effect or paid API call.
