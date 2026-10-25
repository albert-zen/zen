# Public Responses transport (draft, no merge approval)

## Decision and boundary

The user selected native tool media where the protocol supports it, with compatibility logic inside adapters and uniform canonical tool-result objects. The follow-up preference is Responses where an endpoint supports it. This draft introduces an explicit public API-key Responses choice, not a provider-brand heuristic or a migration.

Existing compatible profiles without `protocol` remain Chat Completions and preserve their serialized shape. `protocol: "responses"` selects a separate adapter through the existing Host factory and compatible-provider dialog. Subscription Codex remains its own transport, authentication and endpoint. Nothing probes, switches protocol automatically or resubmits rejected native media in a different format. #500's Chat capability registry is independent and is not a dependency of this draft.

## Supported wire path

- Stateless POST to the configured base URL's `/responses`, or an explicit `/responses` endpoint; `store: false`, stream enabled, no conversation or `previous_response_id` state.
- API-key bearer authentication only. No subscription account, beta, originator or session headers.
- Text and images in ordinary user content; tool images stay in the same `function_call_output.output` array as the receipt and retain the producing `call_id`. No synthetic user message for those images. A provider rejection of native tool media fails closed through the existing `modelRecoveryBlocked` marker: sanitized error and exact pointer remain, but Runtime cannot silently withhold the tool image and retry. An exact ordinary-user-image pointer retains the existing user-image policy; ambiguous image rejection with native tool images is conservative. Other adapters are unchanged.
- Function-schema tools, including `run_code`, with explicit `strict: false`. Subscription custom grammar is not assumed to exist on arbitrary public compatible endpoints.
- Canonical input currently represents text, images and audio, not generic file outputs. This draft supports text and images only. Audio fails explicitly before submission, never silently removed or relabeled. Model image capability remains the existing catalog's responsibility.
- Existing shared Responses SSE parser handles text, tool arguments, usage, incomplete/output-limit, refusal/error and opaque reasoning. Only the codec is shared; subscription transport and serializer remain independent.
- Exact response media pointers map back to the original canonical media object. The safe pointer vocabulary additionally allows `.output` for native function results.

This is documented protocol support and synthetic end-to-end verification, not a claim that every endpoint or model accepting a Responses URL supports all of these fields.

## Opaque reasoning replay

Stateless tool continuation requires the returned reasoning state. The request explicitly asks for encrypted reasoning. New public Responses opaque events retain the actual vendor `providerItemId` and carry optional metadata:

`opaqueReplayProvenance: { version: 1, adapter: "public-responses", endpointSha256: "<64 lowercase hex>" }`

The digest is SHA-256 of the normalized actual request URL. Embedded credentials, query strings and fragments are rejected for this transport. No key, raw URL, account identity or secret-derived digest is persisted. This is a compatibility guard, **not** a security/authentication proof: changing the account behind an unchanged endpoint is not detected. Existing compiler selection filtering separately restricts reasoning to its original provider profile and model.

Canonical decoding, the runtime and message compilation only preserve the uniform optional field. The adapter owns digest comparison and wire serialization; metadata never appears in the provider request. Old summary-only and old opaque journal records remain readable without a migration. Old or different-target opaque content cannot be replayed by the new adapter: it fails before fetch with an explicit unsupported-continuation error. It does not overwrite old history or invent new IDs. Subscription handling is unchanged.

A Responses endpoint returning reasoning without encrypted state is explicitly unsupported for this stateless path. Even empty-summary reasoning is detected, and a failing sample's tools are not executed. Pure text responses without reasoning remain valid. This prevents silently dropping continuation data to make a request look successful.

## Product wiring

The optional compatible-profile selector is saved using existing configuration mutation semantics. Changing it does not send a model request. Host sampling, title generation and the existing explicitly user-triggered image check use the chosen protocol. Title output budgets use `max_output_tokens` for Responses, not Chat's `max_tokens`. Model discovery remains explicit `/models` and strips an explicit `/responses` suffix before constructing that catalog URL. No new capability probing is introduced.

## Evidence checked 2026-10-25

- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling): function output and reasoning continuation contract.
- [OpenAI Responses migration](https://developers.openai.com/api/docs/guides/migrate-to-responses): stateless storage, typed function definitions and strict-mode differences.
- [Official OpenAI Node SDK Responses types](https://github.com/openai/openai-node/blob/master/src/resources/responses/responses.ts): `function_call_output.output` accepts text/image/file input content arrays as well as strings.
- [DeepSeek vision guide](https://api-docs.deepseek.com/guides/vision/): documents a distinct native Responses tool-image mechanism. Its Chat reference/guide conflict is not used to infer Responses support for arbitrary hosted models.

No live provider requests, credentials or billed model runs were used. Any later live validation needs explicit target/account, credential-use and bounded-cost authorization. Use an inert generated image with actual returned call IDs, verify both one and multiple tool outputs, and retain sanitized wire shape and status only. A native rejection must remain visible, not trigger alternate-format guessing.

## Validation and review requirements

Synthetic tests cover Host factory selection and complete model → tool → native media → reasoning continuation; old configuration shape; decoder strictness; raw vendor IDs; unknown/cross-endpoint rejection before fetch; HTTP pointer identity; authentication separation; no format fallback; and existing subscription behavior. The UI preview uses actual SettingsView and synthetic provider data, no Host or network. Current-head CI, independent review and screenshots are required before any merge. A green test suite is not live endpoint validation.
