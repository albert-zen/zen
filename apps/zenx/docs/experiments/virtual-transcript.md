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
- Exact message-target navigation now resolves a canonical turn key and materializes
  it before focusing/consuming the target. Reader input, newer requests and unmount
  cancel the pending reveal. Same-thread inline quote source jumps still use a
  mounted-DOM lookup and remain an explicit production blocker.
- Focus and selection rows are protected with public alwaysRender pins before
  scroll recycling. Native cross-row selection, active media, keyboard traversal,
  and chronological screen-reader behavior still require real-app acceptance.
- Keyed position restore exists but estimate settling, immediate reader-input
  cancellation, thread switching and composer/media resize need native testing.
- No Send latency or bounded-DOM measurement is claimed by this checkpoint.

## Dependency and licensing boundary

The experiment pins npm LegendList 3.3.5 and applies the unchanged `react.mjs`
section of T3's patch at `cefb544af3c98224874419198c0359b652ca3c94` through a
67-line idempotent local preparer. Original/patched git blob hashes are checked.
Both MIT notices are preserved in `apps/zenx/patches`; the copied patch is web ESM
only, not T3's mobile/CJS/types changes or its entire timeline implementation.
CommonJS `react.js` remains stock and is not used by this adapter's tested Node
ESM/tsx or Vite import resolution. See the patches README for exact upstream URLs.
Normal `npm ci` invokes the preparer in the existing workspace postinstall; a
fresh full-repository npm ci was not run in this shared environment. The preparer
refuses symlinked/external dependencies instead of modifying a shared tree.
The adapter uses supported web types and `getScrollableNode`/`getState`/scroll APIs,
not casts into private runtime APIs or unsupported renderScrollComponent.
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

The strengthened actual-component test changes `scrollTop` to 140000, waits for
row-buffer and DOM-order settlement, checks that distant row identities
appear while the original focused/selected node stays connected, and checks that
clearing selection/focus lets it unmount. It also replaces the supported public
`scrollToIndex` method with controlled pending/rejected promises to cover reader
cancellation, newer-request supersession and unmount. No private API is accessed.
The reader-scroll session now lasts across ongoing scroll events and scrollbar
pointer lifetime, with native scrollend and a debounced fallback; actual native
inertial/touch/scrollbar behavior and first-visible pending Send remain unverified.

The patched ESM also passes all 27 focused checks. Five additional preparation
checks pass: exact upstream output/idempotence, reject unknown source without
mutation, reject shared dependency symlinks, actual Vite plus Node ESM import
resolution, and npm lifecycle/pin consistency. Full npm ci, native UI screenshots,
native 5000-turn Send latency and complete reading/find/quote acceptance are not
claimed by these focused tests.
