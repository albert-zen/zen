# Reopen the source of a quote in an unsent draft

Actual offline Linux Chromium 131 renderer with a synthetic 30-turn conversation, no Host/provider calls. Baseline is the exact [merged #761](https://github.com/albert-zen/zen/commit/9e65c3493b668e25d34c3942974716b7360b2e7e); after is an isolated local patch, **not merged**. The flow uses real pointer selection, the Quote action, the bottom arrow, and the draft quote chip by click or Enter. No change to the selection tool, quote format, sending or transcript style.

## Unique passage: return to the excerpt, not only its message

1. In a tall conversation, type an unsent draft, scroll up 5630 px, and drag across a single line. At 1280 × 800 light, select `Review item 19-5 covers`. Quote it into the draft. The existing words before and after the quote stay there.
2. Use the arrow to return to the bottom; the source reply is no longer mounted. Click the draft quote chip.
3. [Before](01-unique-before-light.png), the correct old reply is brought back but the highlight Range collapses when the row remounts. [After](02-unique-after-light.png), the settled reply receives focus, and the exact selected excerpt (offset 425) is visibly underlined at y=436.48 CSS px above the composer. The 960 × 820 dark/Chinese keyboard route retains the exact unique text too.

## Identical passage inside one reply: do not indicate an unproven occurrence

At 960 × 820 dark, select `covers the synthetic` from the fifth occurrence in reply 22 (offset 357), quote it, return to latest and activate the chip with Enter. The stored quote proves its source message but carries no occurrence offset. [Before](03-repeat-before-dark.png), Zen points to the first occurrence (offset 17), not the selected one. [After](04-repeat-after-dark.png), it opens and lightly outlines the correct message from its start without misleadingly highlighting one occurrence. The quote text and surrounding draft are intact. This does not add occurrence tracking to legacy or new references; the message-only fallback is deliberate.

No horizontal page movement, external requests or page exceptions occurred. This is renderer evidence, not a native desktop or persisted Host round trip. The source materialization retains the existing user navigation guard.

## External reference

[T3 Code’s documented citation control](https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md#quote-an-assistant-response) links a draft or sent quote back to its source and keeps the saved quote readable if its source changed. It documents disambiguation for repeated selections on mobile; we do not infer the desktop implementation or copy that interaction. I inspected the [author-operated Linux client recording](https://github.com/user-attachments/assets/c0290098-6c28-471a-8186-0fc968a676b9) from [T3 Code #22293](https://github.com/pingdotgg/t3code/pull/22293): at ~7 seconds a selected range, quote chip and comment editor remain above the composer while selecting and editing synthetic paragraphs. The recording is for the adjacent selection/editing stage, not an offscreen source restoration or repeated-text return. No self-run T3, matched external score, or whole-app rating.
