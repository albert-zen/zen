# Browser comparison fixture: ready, not natively executed

The standalone `fixture.html` is generated from the actual ZenX Markdown renderer
at public source `572fe27e` / tree prefix `bbe3`, plus a literal subset of product
CSS and explicitly synthetic completed-turn outer markup. It has 24 synthetic
turns covering plaintext, line breaks, formatting, lists, tables, fenced code,
quotes/links, Unicode and an empty final message. It is not the ThreadView
component, Legend list, native bridge, complete product presentation, or a React
mount performance test.

## Rebuild

From the ZenX repository root with existing dependencies installed:

```sh
TSX_TSCONFIG_PATH=apps/zenx/tsconfig.web.json \
  node --import tsx \
  apps/zenx/scripts/selection-segments-prototype/build-fixture.mjs
```

The generator accepts `ZENX_SOURCE_ROOT` for a separate read-only source checkout;
its default is the current repository root. It writes the output beside itself.
No dependency installation or browser/server launch is required to generate it.
The `tsx` CLI attempted to create an IPC pipe and was blocked with EPERM in this
execution environment. The repository's existing `node --import tsx` route
successfully generated the file without requiring that CLI pipe. This is not a
browser launch and no denied Chromium launch was retried.

## Execution and reports

Opening `fixture.html` in an authorized existing browser exposes test buttons and
`window.segmentFixture.runAll()`. There is no Copy handler, clipboard writer,
keyboard shortcut replacement, or native command dispatch. The Select fixture
button is test instrumentation using a normal DOM Range, **not** the product's
Select All entrypoint. Product acceptance must still use its actual Cocoa chain.

The browser report keeps raw baseline/candidate strings and reports the first
exact difference without trimming, deduplication or newline normalization.
It separately records whole-selection equality, endpoint identity and text
stability across an interior window replacement. Natural scrolling updates the
retained window; narrowing into a gap pins that exact gap. Reading anchor/layout
and visible native highlights need real visual inspection.

The flat-gap candidate deliberately takes its input text from native selections
of the full baseline. That oracle isolates whether gap layout/boundaries can
preserve serialization. It is **not** a product serializer and cannot supply
never-mounted history. Even a passing fixture would establish only the mechanism
for these cases, not exact production coverage.

Before Arrow/Home/End/Page or a pointerdown inside the viewport, the fixture tries
to fill all gaps with real rows in place and lets the original event proceed.
This does not call preventDefault, replay the event, or modify Selection. If a
Selection endpoint is already inside a gap, fill-all reports blocked and leaves
that gap intact. Such endpoint interactions still need an exact integration
solution; they are not silently counted as a complete native interaction.

## Measured here

Eight JSDOM structural/Range tests passed. Generated browser script ran through
all three candidates in JSDOM without runtime errors and preserved endpoint
identity. **JSDOM has no Chromium rendered-text or layout semantics; these are not
native Selection or clipboard acceptance results.** No actual browser was run.

Static host-element counts for the identical 24-turn synthetic fixture:

- Full baseline: 744 elements, 75 native button elements, 2,055 textContent chars.
- Host gap candidate with 5 real rows: 748 elements, 75 buttons, 2,055 chars.
- Pruned gap candidate with 5 real rows: 596 elements, 37 buttons, 2,055 chars.
- Flat gap candidate with 5 real rows: 162 elements, 16 buttons, 2,055 chars.

The flat count uses JSDOM's oracle string and proves only node-count reduction.
A representative plaintext turn has 27 host elements / 3 buttons; pruning removes
8 elements / 2 text-empty buttons and leaves its one text-bearing status button.
A code turn has 33 / 4 versus 25 / 2, retaining the code Copy label. Equal
textContent is not evidence of equal native line breaks or clipboard output.

## Outcome and remaining gate

The strongest tested result is an in-place range-preserving transition, including
fill-all fallback. An exact host projection removes offscreen React mounts but
keeps O(total DOM). Flattening bounds nodes while retaining O(total characters),
but neither its native serialization nor a production exact text supplier is
established. No claimed select-all speedup can be inferred from these counts.

Next decisive step: run the tiny fixture in the existing authorized Chromium /
Electron environment, inspect the exact raw differences and native highlights,
then use the unchanged product full-DOM/Cocoa driver only for any candidate that
survives. Do not change the accepted raw contract to make a candidate pass.

For context, the [Selection API specification](https://www.w3.org/TR/selection-api/#dom-selection-stringifier)
defines the stringifier in terms of rendered text, not textContent. The
[Chromium frame-selection implementation](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/core/editing/frame_selection.cc)
contains separate visible-selection/layout processing. Those references explain
why DOM-only checks cannot establish the final native contract; they do not pin
the installed Electron engine's behavior.
