# Unified reference v2 contract (implementation plan)

The initial production projection is A: one ordered reference rail outside the Composer and outside the sent user bubble. PR456 remains a frozen v1 comparison/evidence record; it is not automatically relabeled as v2 behavior. This proposal adds no Core item, protocol field, reference resolver, or durable frontend conversation state.

## Canonical payload

The sender emits one canonical text part with a distinct v2 prefix and JSON `{version:2, clientId, text, references}`. `text` is the exact ordinary question. `references` preserves the existing draft array order, not cursor positions. Each entry preserves the complete known target identity and label using JSON string escaping:

- Thread: `kind:thread`, `id`, `name`, `cwd`, `contentMode:pointer`.
- File: `kind:file`, `path`, `name`, `cwd`, `contentMode:pointer`.
- Message: `kind:message`, `threadId`, `id`, `name`, `cwd`, `contentMode:excerpt`, `excerpt`.

A sub-agent is still a Thread target. A full-message and selected-message reference share message identity and exact excerpt semantics. No file/thread bodies are read or included automatically. The model receives this structured envelope as ordinary text; request examples must show that truthfully. Each excerpt appears once per explicit reference, not a hidden repeated representation.

No-reference sends keep the current bytes. Without a valid generated send identity the existing plain-text compatibility path remains visible; no unbound envelope is presented as trusted structure. Presentation requires exact keys/types, recognized version/prefix, canonical JSON round-trip and matching canonical client ID. This is not cryptographic trust. Duplicate keys, unknown fields/versions, whitespace-normalized lookalikes, truncated/partial content, empty identities, and missing/mismatched IDs remain complete ordinary text. No arbitrary pointer strings are inferred as references.

## Compatibility and lifecycle

Read old v1 quote envelopes without rewriting raw data. Their embedded pointer descriptions remain ordinary question text; only the actual v1 quote array becomes reference tokens. Preserve canonical text part boundaries and Host-added skill text. Copy-message returns raw content. Existing draft, retry, queue, failure, newer-edit and acceptance state machines remain unchanged; only serialization at the existing send boundary changes. Editing/resubmitting uses a parsed draft bound to the original queued client ID, not a second envelope. The queue editor keeps exact revision/receipt/retry identities, exposes the same external tokens and permits removal. Invalid/unbound canonical text is encoded as literal visible input before entering the ephemeral draft codec; ordinary pasted reserved headers and leading backslashes round-trip unchanged. The same literal-safe entry boundary applies to the main Composer.

## UI

One production ReferenceToken handles all existing kinds with common compact shape, one details/source affordance, keyboard access and draft-only Remove. Thread/file details explicitly state that only identity/location is included. Message details preserve full whitespace and all source IDs. Source actions use existing exact-target routing where available; unavailable sources are explicit, never silently replaced. The rail moves as a whole outside Composer and sent bubble. Existing images and skills need consistent adjunct grouping without changing their existing payload semantics; they are not silently converted to file pointers.

No new @message picker or true inline editor is claimed by this slice. Those require explicit UI integration and separate input/editing tests. B remains a documented alternative rather than fake editable HTML.

## Required verification

- All kinds, duplicate labels/different IDs, Unicode/newlines/quotes in labels/paths, two message excerpts, exact cross-kind order and no-reference byte equivalence.
- Strict malformed/unknown/duplicate-key/client-ID fallback and v1 compatibility, including old pointer strings and multiple canonical text parts.
- Optimistic-to-canonical hydration, retry/queue identity, failure/newer drafts, edit/resubmit without double wrapping, Copy/Quote semantics and active IME.
- One shared token, draft/sent outside containment, source/details/remove, exact multiline expansion, missing source, keyboard/focus, narrow and touch geometry.
- Regenerate both actual provider HTTP examples through Host/Runtime/journal with the same synthetic five-reference bundle; prove pointers remain metadata-only and excerpts/order remain exact.
- Full production component synthetic send loop, real Linux Chrome captures, independent review, existing full CI. No live model/provider, private file or transcript is required.
