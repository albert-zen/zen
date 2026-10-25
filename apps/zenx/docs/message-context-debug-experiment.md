# Per-message input debugger (decision-only experiment)

This is a separate, default-off experiment, not the trigger bubble redesign.

## Entry and privacy

Source development: `VITE_ZENX_MESSAGE_CONTEXT_DEBUG=1 npm --workspace apps/zenx run dev`.
Only the existing local-owned `localModelDebug` surface can show the button. Production builds do not enable it from that variable (`import.meta.env.DEV` is also required). A fixture-only explicit prop exists for tests. Opening the terminal-style hover action does not enable request capture, send input, replay a turn, or read attachment bytes. Capture must be explicitly enabled beforehand in the existing thread debugger. Host restart, disabling capture, clearing and bounded eviction retain existing semantics. No new persistence or external telemetry.

## What is shown

1. **Saved admitted input** is the canonical incoming message's saved text/content, including exact inline reference envelopes and Host-injected content parts. This is not a reconstruction from rendered Markdown or quote chips, and it is not proof of a provider request.
2. **Captured provider message** uses source identity assigned during the existing canonical compiler, carried through the existing modality projection, and an exact array index recorded by the Chat Completions/Responses serializer. Duplicate text is never matched by value. The debugger extracts only the mapped `role: user` field from the already redacted retained request body; it never displays unrelated system instructions, tools, assistant reasoning, or tool-output supplemental messages as the selected message.
3. Redacted records are visibly labeled, JSON whitespace is formatted, and pagination is explicit. A truncated full request cannot be parsed into a reliable field and is unavailable. There is no claim of byte-exact content after redaction or of server receipt: capture happens immediately before transport, including failed attempts.

Each captured sample/transport attempt is selectable. A message may appear in many requests, may be dropped after compaction, or may not have a capture because logging was off, an old record expired, or an adapter does not provide supported serializer attribution. Those cases say unavailable. Existing custom adapters' `model-input` projections are not misrepresented as actual provider fields. Unknown external message clones lose weak identity and therefore fail closed. Requests above the 1,024-entry attribution metadata limit omit all mappings, not a potentially misleading partial prefix. No Item or wire payload schema is extended.

## Reference example

The saved field retains the serialized reference envelope (thread ID, workspace/path or selected excerpt) at its original position in the human prose. A captured Chat field may additionally contain the recorded user-message timestamp as a separate text part; Responses uses `input_text` parts. This panel exposes both stages without treating their difference as corruption. The synthetic preview uses the real reference serializer, and adapter tests verify actual serialized field selection and byte-identical requests with capture off/on.

## Validation boundaries

Tests cover duplicate text, exact provider indices, tool supplemental entries, multi-part references, media projection, compaction retention/omission, unknown clone/adapters, ambiguous/missing/non-user mappings, credential redaction, truncation, clear, explicit capture opt-in and closed-panel late reads. Browser capture uses actual action/Dialog/styles and a synthetic message scaffold/capture bridge, not a live Host or online model. CI captures English desktop/light and Chinese narrow/dark, checks bounded layout, attributed-only requests, Escape and focus restoration.

This PR is not approved for merge. Full native desktop and online provider acceptance remain separate.
