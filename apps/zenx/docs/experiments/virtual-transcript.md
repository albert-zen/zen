# Virtual transcript prototype (WIP, disabled by default)

This experiment replaces the real ThreadView viewport, including ordinary Send,
with `@legendapp/list/react` 3.3.5. It keeps the full canonical row array, stable
Thread/Turn keys, ordinary upward/downward scrolling and one scroll owner. It
does not require a Load earlier action. Pending sends stay inside the measured
footer. ZenX continues to own following and user disclosure state.

Enable only in a disposable test tab before mounting ThreadView:
`sessionStorage.setItem("zenx.experimental.virtualTranscript", "1")`, then reload.
Remove that sessionStorage entry and reload to return to the unchanged full-DOM
path. The virtual path displays an explicit experimental warning.

## Not production-ready

- Browser-native Find and Select All cannot include unmounted history. They are
  explicitly warned about, not replaced with manual paging or claimed equivalent.
- Source-target and inline quote navigation still need virtual materialization.
  The adapter exposes `reveal(key)` for that work.
- Focus and selection rows are protected with public alwaysRender pins before
  scroll recycling. Native cross-row selection, active media, keyboard traversal,
  and chronological screen-reader behavior still require real-app acceptance.
- Keyed position restore exists but estimate settling, immediate reader-input
  cancellation, thread switching and composer/media resize need native testing.
- No Send latency or bounded-DOM measurement is claimed by this checkpoint.

## Dependency and licensing boundary

This checkpoint uses stock npm LegendList 3.3.5, not the exact patched T3 runtime.
T3 at `cefb544af3c98224874419198c0359b652ca3c94` applies a web patch covering
state-preserving DOM moves, offscreen pin positioning and bounded corrective
layout chains. That patch is not copied here. Both licenses were inspected:
LegendList: MIT, copyright 2022 Moo.do LLC; T3: MIT, copyright 2026 T3 Tools Inc.
Any copied patch must retain its applicable license notices. The adapter itself
uses only the supported web types and `getScrollableNode`/`getState`/scroll APIs,
not casts into private runtime APIs or an unsupported renderScrollComponent.

Before enabling by default, finish whole-data find and precise target navigation,
then run the existing native ordinary-Send and reading/selection acceptance on the
exact final revision. Capture actual running UI screenshots before any merge.

## Focused checks on the prototype

- Web renderer TypeScript check passes.
- Existing reading-state and side-chat quote routing tests: 21 pass on the
  unchanged default DOM path.
- Pin/anchor unit tests: 5 pass.
- Actual npm LegendList component test with deterministic JSDOM geometry: 1 pass.
  It confirms one viewport, pending-send footer inclusion, fewer than 60 mounted
  rows from 1000 data rows, focused/selected mounted-row retention through native
  pin/scroll events, no flushSync/nested-update warning in that flow, and a pending
  reveal resolving cancelled on unmount. This is not real browser selection,
  native layout or a Send latency result.
