# Room receipts, replies, and reactions: focused GUI verification

Actual Linux Electron captures on source `551a19a5ab5e27a1a1080fad97e3fdcfdabb8dae`, renderer `index-D8XOSQMs.js`, with the isolated local mock provider. The app was built with Rooms 1.0.5. No real model account or API key was used.

The final source candidate is `9bca6e061e31c166b7e14eea0ad74b34ff9ea225`. Its later change corrects the saved-message operation revision fallback and adds regression coverage; it has no visual changes. The screenshots therefore retain their exact capture revision above. That last fix was owner-verified after the third independent review, rather than independently reviewed again.

## Current evidence

- [Host-attributed agent reply and source Thread](attributed-agent-light.png): the new explicit Room post displays **Assistant**, and Message details identifies the exact bound Thread. The older generic Agent post remains historical; this change does not rewrite past messages.
- [Quoted reply, Read receipt, and reaction](quoted-read-light.png): replying to the Assistant post preserves its author/text, sends the human message, then displays Delivered to Room · @Assistant: Read. A heart was added with the actual UI.
- [Dark Room](quoted-read-dark.png), [narrow dark Room](narrow-dark.png), and [narrow light Room](narrow-light.png): quote, receipt, reaction, and Composer fit at 598px. Native window controls remain above the title; scrolling clips history at its pane boundary, not through the Composer.

## Interaction results

On this final visual candidate, a newly posted Assistant message has Host-derived name and source Thread; a new human quoted reply reaches Read; theme changes preserve the message and reaction. The Agent message and its eye reaction were created through the trusted public Room tool service with the bound Thread invocation, then inspected in the real UI. This is a synthetic tool fixture, not proof of an autonomous model decision.

The preceding GUI pass on this branch also exercised Reply cancellation, quoted draft retention across Room → working Thread → Room, send, reaction add/remove/re-add, and app restart persistence. Removing the human heart left the separate agent eye reaction intact. Those earlier captures are superseded visually and are intentionally not embedded here.

The three review regressions (evicted-operation receipt fallback, refresh of older loaded reactions, and recovery after stale-quote preparation fails) passed the existing behavioral regression suites. They were not fault-injected through the GUI. The final code review and complete test results are recorded separately in the PR.

## Limits

Read describes the recorded admission of the message into the linked Thread context. These screenshots do not establish model comprehension, exact remote provider consumption timing, or busy-turn timing under every provider. Native Windows/macOS, remote Fleet delivery, and real model providers were not exercised in this focused check. This report is not an all-page audit.
