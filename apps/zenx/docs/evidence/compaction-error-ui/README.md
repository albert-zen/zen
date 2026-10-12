# Context compaction error UI — isolated fixture

Both images are **synthetic failure** captures of the production `ThreadView`
React component and `requestContextCompaction` executor in Electron 43.2.0,
macOS, dark theme, 1280×820 CSS viewport (PNG backing scale 2). The fixture
throws an artificial `Error invoking remote method` exception and contains
only synthetic Thread text. No real Host, user conversation, daily app or
compaction operation was used. It does **not** reproduce the user's original
unidentified failure or establish its root cause.

- [Collapsed error card](synthetic-compaction-error-dark-1280x820.png): notice above Composer, not below textarea nor inside the closed context popover.
- [Expanded details](synthetic-compaction-error-dark-1280x820-details.png): native `<details>` summary focused and expanded in hidden Electron window; original exception text withheld. Focus was set programmatically for capture, not an active-window Tab-navigation acceptance test.

Screenshot driver and DOM capture assertions are in this work line's local
`compaction-error-ui/capture-electron.cjs`, `run-capture.mjs`, and
`capture-final.log` artifacts. Fixture source is in
`apps/zenx/test/fixtures/compaction-error-visual.{html,tsx}`. The screenshot
captures component paint, not a packaged/signed daily-app test.

## R1-1 follow-up · bottom-zone layout at actual minimum window

The production window config has `minWidth: 360` and `minHeight: 560` (not
350×400); the macOS-style titlebar occupies 44px, leaving 516px for the
synthetic `.thread-view` in the 360×560 probe. The probe uses production
`ThreadView` and styles in an isolated Electron window, with a synthetic prior
failed request followed by an in-progress Turn, pending approval, six queued
messages and an 18-line draft. This sequence is possible because compaction
failure feedback persists in its Thread's transient Composer state across new
turns. It does not call a real Host or reproduce the user's original error.

- [360×560 dark, expanded error](r1-green-min-crowded-dark.png): error summary,
  disclosure and Dismiss remain visible in the bounded bottom zone. The send
  control is below its scroll viewport while details are expanded.
- [After focusing Send](r1-green-min-send.png): the internal scroll reveals
  the send control in its viewport.
- [After focusing approval Allow](r1-green-min-approval.png): the same scroll
  route reveals the approval action; queue content remains present.

The frozen pre-fix RED screenshots and exact rect/scroll measurements for
360×560 dark/light, 600×560 light and 1280×820 dark are in the work artifacts
`compaction-error-ui/r1-red-*.png` and `r1-geometry-{red,green}.json`.
Under the pre-fix CSS, the alert itself was **not clipped** in this bounded
matrix, but an approval and part of the queue were clipped with no bottom-zone
scroll path. Fix: bound that zone to its container, allow internal scrolling,
and pin a new failure to its bottom once, without repeatedly resetting the
user's scroll. Focus movement in the capture is programmatic in a hidden
window and the rects demonstrate actual pixel reachability, **not** an
active-window physical Tab-navigation or packaged Windows acceptance test.

## Transcript-access delivery follow-up (after R2 and six-source Phase C)

A six-source integration fixture exposed a delivery boundary that the single-PR
R2 did not claim to solve: a bottom zone taking all 516px of ThreadView could
cover the canonical transcript entirely, even while the scrollable controls
were individually reachable. This was also reproducible with the isolated PR214
production component at its prior head; it is **not** a claim that this PR
introduced the original overlay behavior. The new CSS reserves a reading lane
above only an overflowing bottom zone, and the message scroller's bottom
padding ends before the zone starts. The existing internal zone scrolling,
error identity, explicit Dismiss, queue, approval, and composer draft remain.

These are hidden Electron 43.2 production-component + synthetic fixture images,
not a user invoke repro, active-window Tab acceptance, or packaged/Windows
capture. The prior RED images and failed early GREEN sampling attempts remain
in the author's `compaction-error-ui/` work artifacts with exact geometries.

- [360×560 dark, three short paragraphs](transcript-green-min-dark-short-crowded.png): all paragraphs fully readable above the expanded error card.
- [360×560 dark, long message ending](transcript-green-min-dark-long-crowded.png): final paragraphs 30–32 are readable at a distinct scroll position.
- [600×560 light, short paragraphs](transcript-green-mid-light-short-crowded.png): narrow-height theme contrast.
- [1280×820 dark, short paragraphs](transcript-green-wide-dark-short-crowded.png): normal-width case.

Probe `transcript-access-probe.cjs` in the work artifacts samples three distinct
text paragraphs and uses their real rect, ThreadView clip, bottom-zone top,
and `document.elementFromPoint` against the `.agent-copy` under each sampled
text point. For long messages it separately scrolls the first two and last
three paragraphs to readable positions. It does not assume a successful
`focus()` alone proves visibility or expect the entire long message at once.
