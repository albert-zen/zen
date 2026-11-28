# Narrow workspace: return to the same reply after Escape

Evidence archive only. This does not ship the candidate. Baseline is the exact merged ZenX renderer from `9e65c3493b668e25d34c3942974716b7360b2e7e` via [#761](https://github.com/albert-zen/zen/pull/761). Candidate uses the same compiled renderer and app logic, with only the isolated narrow-workspace stylesheet appended in the browser fixture. CSS patch SHA-256: `c115613305dea33b9e6030048e40a0af828ba19d1c9ef73f86fce953874f146e`. This run does not depend on the previously scored JavaScript change for wider split panels.

Reproduction: in the main conversation, start a synthetic draft, wheel upward 780 px from the latest completed messages, open the ordinary right workspace, and press Escape while focus is on its Close button. Dark, 960 × 820, DPR 1, cloud Linux Chromium 131, reduced motion. Both versions use the same initial focused controls, viewport, synthetic content and draft. No actual Host, account, external traffic, or page error.

| State | Screenshot evidence |
| --- | --- |
| Reading older reply, workspace closed | [Before](01-before-opening.png), byte-identical across both variants |
| Workspace covers conversation | [Open](02-workspace-open.png), byte-identical across both variants |
| Escape and return to conversation | [Main](03-escape-main.png): position 10538→0, jumps from section 14 to first message; [CSS-only candidate](04-escape-candidate.png): 10538→10538 and same paragraph character at +15 px |

Draft and focus return to the same respective state; the existing down arrow still returns to latest. A second light run at 800 × 820 held 12968 px on the candidate versus zero on main. At 1440 × 1000 the narrow CSS is outside its media query; the separate split-workspace regression and ratings are not this result.

The combined local candidate was also exercised in a synthetic stream while the chat was covered (offset remained fixed, and return-to-latest still followed), and with macOS renderer styling. None of this is a macOS/Windows native acceptance. No matched external narrow-collapse picture or runtime was available; [T3 #41184](https://github.com/pingdotgg/t3code/pull/41184#evidence) documents desktop split reflow, not this Escape/overlay path. No independent score was assigned to this narrow case.
