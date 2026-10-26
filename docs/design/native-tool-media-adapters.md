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
back to original media objects, accounting for the already materialized receipt text
placed before media parts. The adapter does not construct receipt/exit-status wording.

## Current protocol evidence (checked 2026-10-25)

- OpenAI Chat Completions documents tool.content as string or text parts. The generic
  compatible adapter therefore retains its existing fallback unless given exact-target
  evidence. https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
- DeepSeek native Chat schema documents image/file parts in tool.content, but the Vision
  guide says images are user-only and confirms deepseek-flash (not deepseek-v4-pro).
  These sources conflict, so no default native Chat entry is justified yet. Neither
  source establishes support for a hosted DeepSeek model on DashScope or another proxy.
  https://api-docs.deepseek.com/api/create-chat-completion/
  https://api-docs.deepseek.com/guides/vision/
- Public OpenAI Responses documents media output content. The currently implemented
  subscription adapter targets chatgpt.com/backend-api/codex/responses, not the public
  API endpoint. This draft does not assume those endpoints share native output support.
  https://developers.openai.com/api/reference/resources/responses/methods/create

The current canonical media vocabulary is image/audio. This draft adds no file-media
journal variant, public Responses integration, Claude adapter or Gemini adapter.

## Deliberately unresolved rollout boundary

The Host factory now injects adapter-owned reviewed profiles. The native-capability
list is deliberately empty; two exact endpoint/model records identify conflicting
documentation instead. Consequently existing configurations remain on compatibility
encoding. Product native activation is blocked on evidence, not on a missing adapter
boundary. The separately selected public Responses adapter (#506) is independent;
this framework is not functionally blocked by that transport.
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

The initially proposed DeepSeek Chat defaults are withdrawn after checking the Vision
guide. It confirms only deepseek-flash image input and says user messages only, while
the Chat schema lists tool images. No native declaration should be enabled until that
conflict is resolved with authoritative evidence or separately authorized contract tests.
The same guide explicitly supports tool-output images on public Responses, but this
repository's subscription Codex endpoint is not that API. No new adapter is implied.
DashScope hosted IDs and model-name aliases remain unverified. No audio/file or v4-pro
vision capability can be inferred from the model's presence in the Chat model enum.

Before rollout, surface selection encoding/reason and declaration evidence in the
provider's developer inspection path, outside provider wire content. Decide separately
how operators override or withdraw a declaration when endpoint contracts change. Do not
persist failed-request guesses as capability state. No native profile is enabled by this draft.

## Follow-up: observable compatibility decisions

The existing opt-in request observer and in-memory debug summary now expose six bounded
counts: nativeToolContent, compatibilitySupplement, unknownTarget, undeclaredMedia and
nativeSupportUnverified and conflictingEvidence. These count tool results, not tokens, bytes or attachments.
No extra capture is enabled. Payload inspection remains the exact serialized body;
summary data never enters the provider request or canonical journal. Counts are
allowlisted and capped; endpoint URLs, evidence text and arbitrary profile fields are
not accepted. Subscription output supplements are explicitly marked unverified for
native support, rather than inferred from public Responses documentation.

Qwen was independently checked as an alternative on 2026-10-25. Its Function Calling
Step 5 permits image arrays in tool.content, but its Chat API reference still requires
a string for Tool Message content. The Vision page confirms qwen3-vl-plus and says the
legacy Beijing endpoint remains functional; it does not resolve the tool-role conflict.
Consequently no Qwen native default is enabled either. An official clarification or
separately authorized contract test is needed before registering that target; do not
convert conflicting documentation into a claimed verified capability.

- https://help.aliyun.com/en/model-studio/qwen-function-calling
- https://help.aliyun.com/en/model-studio/qwen-api-via-openai-chat-completions
- https://help.aliyun.com/en/model-studio/qwen-vl-compatible-with-openai

The deferred #498 provenance patch must preserve this separate summary argument when
adding message-source metadata to observeRequestBody; neither datum belongs in the
wire payload. The two features are independent and this draft does not include #498.

## Bounded live contract verification recipe (not run)

Prerequisites: the owner must separately authorize the exact provider account/endpoint,
model, credential use and a small explicit spending cap. Obtain credentials through the
normal secure configuration path, never through chat or this document. Confirm current
pricing and output limits first. This recipe grants no authorization itself.

Use a generated 1x1 PNG with no private content and two inert, read-only fixture tools.
First validate serialization entirely with fake fetch. For live testing, ask the chosen
model for one fixture tool, then return its actual call ID with an image in native tool
content. In a separate case request two fixture tools, and return both actual call IDs
contiguously with the first result carrying the image. Stop as inconclusive if the model
does not produce the required calls; do not invent historical call IDs or repeatedly
prompt until it does. A text-only control can distinguish pairing failures from media
format rejection. Budget at most six requests total and 256 output tokens each, subject
to the approved monetary cap; send no user files and perform no real tool side effects.

Record endpoint protocol, exact model/version, date, status/code and the minimal
synthetic request shape. Do not retain credentials, headers or query strings. A failed
native request must not silently resubmit using fallback. Test compatibility as a
separately planned case only within the approved cap. A successful synthetic contract
test is target-specific evidence, not proof for aliases, other regions or hosted models.
Before adding a native registry entry, review the documentation conflict, fixture and
result together. Re-review or withdraw entries when model/version/endpoint contracts
change; do not maintain inferred durable capability state from runtime failures.

Public OpenAI Responses, Claude tool_result and newer Gemini function-response media
are distinct native protocol mechanisms. Their existence does not enable them in this
product's current Chat-compatible and Codex-subscription adapters. Adding/selecting a
new public Responses transport is a separate architecture and product decision, not a
reason to send public Responses shapes to the subscription endpoint.

## Canonical-content integration (2026-10-26)

The context compiler materializes all model-facing semantic text, including tool
receipt framing, media fallback notices and system instructions, before AppServer
commits and dispatches. Adapters only encode those committed strings and typed
media. A wire-level user-role compatibility supplement keeps tool provenance in
canonical content; it does not become a human-authored message. This framework
adds no second history, late semantic prefix, provider probe or fallback retry.

The current integration regression passes real compiler output through the native
Chat serializer and verifies exact committed text/order, source tool identity and
image placement. This is synthetic encoding evidence only; the default native
capability registry stays empty.
