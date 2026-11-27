# Queue Steer on the merged desktop renderer

Product under test: [main 9e65c34](https://github.com/albert-zen/zen/commit/9e65c3493b668e25d34c3942974716b7360b2e7e) (#761). These are original, unmodified Chromium 131 captures on Linux. The repository’s `apps/zenx/test/fixtures/queue-steer-visual.tsx` renders the real ThreadView with an offline synthetic protocol. No native macOS or Windows app, device, real traffic, or real data was used.

| Run | Original screenshots | Observation |
| --- | --- | --- |
| 1280×800 dark, fine pointer and keyboard | [Rest](1280-dark-rest.png), [hover](1280-dark-hover.png), [Tab focus](1280-dark-keyboard.png), [after Enter](1280-dark-activation-after.png) | The running turn has two prompts already staged and one Planning assistant message waiting for the next turn. Steer appears on real hover, disappears on pointer exit, and has a visible focus ring on Tab. It has a separate target from composer Send. Enter acts on the queue row, not the composer. |
| 390×820 light, emulated touch | [Before tap](390-light-touch-before.png), [after tap](390-light-activation-after.png) | The action is visible without hovering. A tap acts on that row. No horizontal overflow was observed. This emulates a coarse pointer in Chromium, not a physical device. |

In both activation runs the synthetic protocol moves only the selected item into the current conversation, keeps its source visible, and leaves the two other prompts and the separately typed unsent draft alone. This is renderer interaction evidence, not confirmation of live transport. Before/after here means before/after activating Steer on the same build, not a comparison with the pre-merge version.

[T3 Code #11673](https://github.com/pingdotgg/t3code/pull/11673) is a reference for a busy turn with a queued message, a distinct unsent draft, and a separate inline queue action. Its author’s dark screenshot does not show the hover, keyboard, or touch transition or match Zen’s staged items and source layout. No matched reference run or numerical rating is claimed.
