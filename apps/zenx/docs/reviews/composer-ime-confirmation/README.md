# Confirming CJK input is not sending a message

Actual offline Linux Chromium 131 ZenX renderer, synthetic draft and controlled bridge that records but never transmits a send request. Source for the baseline is [merged #761 `9e65c349`](https://github.com/albert-zen/zen/commit/9e65c3493b668e25d34c3942974716b7360b2e7e). The after version is an isolated **unmerged candidate**. Plain composer: 1280 × 800 light / Chinese. Quote-chip composer: 960 × 820 dark / Japanese text (Zen shell falls back to English for that locale).

## Before / after

1. Type a CJK draft in an existing conversation. In the quote-chip version, also select and quote an earlier synthetic reply.
2. Deliver an Enter keydown with `isComposing=false` and legacy `keyCode=229` to the focused editor. The event is intentionally injected into the browser to emulate timing after composition end; these images are **not** a claim of reproduction with a real OS input method.
3. Before: the event was consumed as send; the bridge recorded one request and the visible draft was cleared. After: no request, same text and quote, no newline from the quoted editor's own keymap, focus stays in the editor. A subsequent ordinary Enter makes exactly one request with the complete draft. Shift+Enter remains a newline rather than send.

| After the IME-shaped event | Before | After |
| --- | --- | --- |
| Plain Chinese draft | [01](01-plain-before.png) | [02](02-plain-after.png) |
| Japanese draft with a quote | [03](03-quote-before.png) | [04](04-quote-after.png) |

The separate Chromium composition-protocol control produced a trusted Enter with `isComposing=true` in both editors. It made zero send requests in both versions; the input was later committed and an ordinary Enter sent once. Chromium's synthetic key/composition sequence is not a physical keyboard or an OS candidate-picker test. Zero external browser requests and page exceptions. Room and queue-editor actions were not assessed here.

## Reference

[T3 Code #2817](https://github.com/pingdotgg/t3code/pull/2817), merged at `d25090cf6d2f334668bf1cba75b6ce3d78beb237`: its main composer distinguishes composition Enter via `isComposing` or `keyCode=229`; the documented reason is to let the input method commit text without triggering send. This is a primary implementation reference, not an independently run T3 app, screenshot, or external score. Zen's quote editor additionally avoids CodeMirror interpreting that event as a newline. Two local regression routes fail on the unchanged renderer and pass on the candidate; 12 directly relevant tests and renderer typecheck passed.
