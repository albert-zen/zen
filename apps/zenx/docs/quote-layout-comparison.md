# Quote and attachment layout comparison

Status: two synthetic layout studies, not a selected product design. Baseline is PR #453 at `373c3de04b3147a0bdf33e0fe2a03c6ce3b98418`. No renderer production source, data schema, send, retry, queue, or provider path is changed by this comparison.

## What the two samples show

- A, external context: file, image, and quote tokens are all outside the draft composer boundary and the sent user bubble. The body contains only the question.
- B, inline context: the same three kinds of object participate in the text flow, in the same visual order before and after sending. This is an ordering sample, not an implemented rich-text editor. It does not claim that the existing payload retains cursor placement.
- Both use the production `MessageQuoteCard`, `ComposerShell`, `ComposerEditor` (A), `Markdown`, icons, and theme. Asset tokens are fixture-only presentation samples. The quote is recovered through the unchanged production serializer/parser. The same payload is produced for A and B. No text resembling a path/reference is parsed or removed from a real message.
- The example includes synthetic `interaction.md` and `page.png`. These are not user files or uploaded images. No provider, host import, or network request is made by the page.

## Existing ZenX boundaries

`ThreadView` draft: skills, references, images, and the plain-text `ComposerEditor` are separate children inside `ComposerShell`. File/thread references are structured in the ephemeral draft prefix, but `referenceMessage` joins their text representation into the sent question. The existing quote envelope preserves exact source IDs and excerpts. Images use canonical attachment content/projection and render outside the sent bubble. This explains the currently inconsistent arrangement.

A consistent external layout can keep the plain-text editor and a single context rail, but sent file/thread tokens still need a deliberately recoverable representation if that visual form is desired after reloading. They cannot safely be inferred from arbitrary user text.

True B needs ordered text/object parts and an editor with atomic selectable objects, cursor positions, keyboard deletion, IME, paste, and accessibility behavior. It also needs an explicit decision on how ordered content round-trips through canonical input. Styling the existing textarea cannot implement that contract. This study adds none of those commitments.

## Verified references and their limits

- Tencent WorkBuddy official conversation documentation: https://www.codebuddy.cn/docs/workbuddy/Conversation . It documents selecting text, Copy/Add to conversation, optional annotation, full-text hover, and multiple references in one message. We inspected its actual quote annotation PNG: https://download.codebuddy.cn/web/docs/aafbbf51beede9ed92e891325729f1e61074e0a4/docs/static/conversation-quote-annotation.tjsvmGP9.png . That image shows an annotation input beside selected response text, not arbitrary inline insertion in the composer. Thus B follows the requested direction; arbitrary placement is not asserted as verified WorkBuddy behavior. No copied product screenshot is included in this source checkpoint.
- The Codex outside-bubble direction is the requested design pattern. The current official feature URL redirects and did not establish a matching attachment-placement screenshot in this check. A is not labeled as a pixel-faithful or independently verified current Codex implementation.

## Recommendation

For ZenX's current whole-message question plus supporting context, A offers the clearest distinction between the instruction and the material it refers to, and a stable place to scan/remove all context. This is a semantic reason, not only a lower implementation cost. If the intended core use is several targeted comments with references interleaved in a specific order, B is more expressive and should be implemented as real ordered content rather than approximated by a row above the textarea. The choice remains open pending visual feedback.

## Verification and reproduction

Build: `node apps/zenx/scripts/build-quote-layout-preview.mjs /tmp/zenx-quote-layout`.
Capture on the existing Ubuntu CI Chrome: `node apps/zenx/scripts/capture-quote-layout-preview.mjs /tmp/zenx-quote-layout`.

Capture asserts actual fine-pointer/hover capabilities, all adjuncts outside A's boundaries and inside B's boundaries, identical payloads, 28px quote controls, no horizontal overflow, and source/removal/restore controls. It uses the existing bounded helper and explicit desktop-input emulation, not native physical hardware. Light, dark, narrow, and long-quote screenshots are generated. Fonts are installed through the existing authorized official Ubuntu step. Full existing CI checks remain in place.

Local checks: fixture build and inline JavaScript syntax check; actual bundle DOM smoke; unchanged quote component/selection/serialization/sent regressions (20 tests); renderer TypeScript check. Screenshot acceptance is separate from those checks and must be based on the exact resulting CI artifact.
