# Native tool media: adapter boundary draft

Status: experimental foundation, not a production capability rollout. No real provider
requests were made for this change. Fixtures validate our encoding, not provider acceptance.

## Decision

Canonical tool results already hold text, modelContent and call identity. Preserve those
objects and journal semantics. Native transport representation belongs in the adapter,
not in run_code, tools, the model loop, or canonical history. Nested calls inside one
run_code remain one top-level tool result; multiple top-level calls are a separate case.

A Chat adapter may receive host-owned toolMediaCapabilities declarations. Each declaration
names the fully resolved endpoint, exact model, protocol, supported media kinds and a
human-readable evidence reference and review date. One declaration must cover all media in a result.
A provider display label, model-name substring, user-input image support, or a successful
request to another endpoint is not sufficient evidence.

The adapter snapshots declarations at construction. The pure exported selector exposes
both the selected encoding and the reason (declared-support, unknown-target, or
undeclared-media) for inspection. Declarations and selection metadata are not sent to
providers and do not enter canonical history.

## Wire examples

For assistant calls A and B, where A returns an image:

- Native: assistant(A,B), tool A [receipt text, caption text, image], tool B.
- Compatibility: assistant(A,B), tool A text, tool B text, user [caption text, image].

Compatibility media is emitted after the contiguous result batch, not at the end of all
history. Fallback supplements retain their order relative to each other; each result retains its
internal part order. In a mixed batch, a later native result can precede an earlier
fallback supplement because the latter must follow all tool replies. Native media stays
inside its own tool_call_id. Both preserve every content part and its ordering. Textual
receipt/exit status remains present. No image is silently discarded.

Selection occurs before submission. A provider rejection does not silently change the
selected format or resubmit the request. Existing explicit media-rejection handling and
provider error classification are unchanged. The adapter maps provider content indices
back to original media objects, accounting for its prepended receipt text.

## Current protocol evidence (checked 2026-10-25)

- OpenAI Chat Completions documents tool.content as string or text parts. The generic
  compatible adapter therefore retains its existing fallback unless given exact-target
  evidence. https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
- DeepSeek native Chat documents image/file parts in tool.content. This does not establish
  support for a DeepSeek-named model served through DashScope or another proxy.
  https://api-docs.deepseek.com/api/create-chat-completion/
- Public OpenAI Responses documents media output content. The currently implemented
  subscription adapter targets chatgpt.com/backend-api/codex/responses, not the public
  API endpoint. This draft does not assume those endpoints share native output support.
  https://developers.openai.com/api/reference/resources/responses/methods/create

The current canonical media vocabulary is image/audio. This draft adds no file-media
journal variant, public Responses integration, Claude adapter or Gemini adapter.

## Deliberately unresolved rollout boundary

No existing Host constructor supplies these declarations yet. Consequently this draft
alone does not change existing user configurations to native mode. Choosing a persistent
provider capability schema/UI, shipping an audited endpoint/model capability registry,
or adding a separate public Responses adapter requires a follow-up design decision.
The draft is intentionally explicit about that limitation rather than hiding an unverified
model-name workaround. Capability evidence must be reviewed when an endpoint/model
contract changes; absence of evidence retains the compatibility encoding, not a probe.

Do not use ordinary model inputModalities as tool-role transport capabilities. They answer
different questions. Do not treat a brand's extension as the generic Chat contract.

## Debugging and validation

Actual request-body observation remains at the final serialization boundary. No synthetic
user source identity is attached to tool-derived media. The deferred #498 provenance work
must continue to map actual human messages only after adapter-generated output positions
are final; native encoding changes those indices but never source identity.

Tests cover parallel batches with first/middle/last/all/no media, consecutive batches,
trailing reasoning, unchanged input objects, exact call pairing and native/fallback
rejected-media pointer attribution. Additional rollout testing must verify the declared
endpoint/model contract; local fake-fetch tests cannot substitute for that evidence.

## Recommended next integration (proposal only, not enabled here)

Keep the reviewed registry in the model adapter package, not the generic loop or UI.
Have Host construction inject that registry unchanged. The matching key is the final
request endpoint plus exact model ID and protocol; configuration supplies no model-name
heuristic. Record documentation URL, review date and supported media types on each entry.

A first candidate for review is Chat endpoint https://api.deepseek.com/chat/completions,
model IDs deepseek-flash and deepseek-v4-pro, image only, based on DeepSeek's current
Chat schema and https://api-docs.deepseek.com/ endpoint example (reviewed 2026-10-25). Its /v1 alias needs separately verified endpoint
coverage before registration. File support in that schema is not an excuse to add a
canonical file variant in this patch. Audio is not declared by this candidate.
DashScope's hosted DeepSeek IDs receive no such entry. Generic OpenAI Chat keeps the
text-tool fallback. Codex subscription remains unknown for native tool output media,
regardless of public Responses capabilities.

Before rollout, surface selection encoding/reason and declaration evidence in the
provider's developer inspection path, outside provider wire content. Decide separately
how operators override or withdraw a declaration when endpoint contracts change. Do not
persist failed-request guesses as capability state. No registry is enabled by this draft.
