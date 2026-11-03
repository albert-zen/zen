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
  cancel the pending reveal. Same-thread inline quote source jumps now materialize
  an exact canonical source row synchronously, then settle through the same reveal
  ownership fence. Main/sent boolean and queued HTMLElement-or-null contracts are
  unchanged; unknown/wrong-thread sources keep the existing explicit fallback.
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
Normal `npm ci` invokes the preparer in the existing workspace postinstall. A
fresh full-repository npm ci passed with all lifecycle scripts enabled in an
isolated Linux / Node 24.22.1 dependency tree. Cache/temp paths were relocated to
the writable workspace; no lifecycle scripts or source were bypassed. The fresh
installed ESM blob matched the upstream target and preparation was idempotent.
The preparer refuses symlinked/external dependencies rather than modifying a
shared tree.
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
resolution, and npm lifecycle/pin consistency. The same 32 focused tests also
pass on the fresh npm-ci-installed dependency tree. Native UI screenshots,
packaged native builds, native 5000-turn Send latency and complete
reading/find/quote acceptance are not claimed by these checks. Electron 43's
package has no install lifecycle; an Electron binary was not installed or launched
by this dependency verification.

Commit-range whitespace validation passes for non-vendor source. The exact copied
unified-diff artifact has three required one-space blank context lines and is a
narrow documented exception, not a full commit-diff whitespace pass. See the
patches README; do not trim the hash-matched upstream patch to hide this result.

The virtual viewport retains the existing desktop 24px / ≤640px 20px transcript
rhythm, including footer gaps and matching header/footer insets. Its warning uses
the existing `--text-secondary` theme alias. These are source contract checks,
not responsive screenshot acceptance.

For existing passive size observation, `.messages > .virtual-transcript-content`
is the stable app-owned total-content box supplied through Legend's supported
`contentContainerClassName`. It has min-height:100% rather than fixed viewport
height, and contains the header, totalSize-height row region and pending footer.
No additional scroll owner or measurement probe is needed.

## Inline source navigation checks

Canonical source identity is resolved only on explicit navigation from the full
canonical quote projection into its represented Turn/Item. Tool-result aliases
resolve to the same rendered tool detail; only necessary Turn/Trace/Item
choices are opened. Final-answer and top-level input sources do not unnecessarily
expand completed history. Public `alwaysRender` plus a closed-stable `dataVersion`
pin signature allows one distant row to materialize synchronously; no private API,
fake source element, Promise return widening or all-history mount is used.
`captureReveal()` provides request-scoped cancellation so stale Find cleanup
cannot cancel a newer source action. Both jump entry points protect an existing
selection before a delayed selectionchange can arrive.

Controlled-layout tests exercise actual ThreadView composer, sent-message and
queued-editor sources in initially unmounted history, queue/main draft retention,
missing/wrong-thread fallbacks, delayed queue-focus cancellation, and nested tool
result disclosure. The existing quote/queue regression tests are retained. These
checks do not replace native reading, focus, accessibility or screenshot acceptance.

The initial whole-ThreadView synthetic layout used an incompatible hardcoded
scroll height and unclamped JSDOM scrollTop and ended with SIGKILL. It was not an
assertion-only failure. The corrected test derives its height from the actual
Legend totalSize region plus its controlled header/footer sizes and clamps offsets
like a native scroll node. A test-only callback budget retains recent offsets and
a bounded failure stack instead of permitting another runaway retry. Passing this
controlled layout is not proof that native layout cannot have a loop.

At this inline-source checkpoint, 88 focused tests pass (8 preparation/layout and
80 component/reading/quote/queue tests), and renderer TypeScript checking passes.
The non-vendor source diff is whitespace-clean; the copied patch exception above
is unchanged. No packaged/native execution was added by this source-verification
stage.

Cancelled virtual message targets are retired by exact local Thread/request ID.
A later canonical snapshot cannot restart a reader-cancelled or superseded target,
and cancellation never calls the exact-target `consumed` callback. Snapshot effect
cleanup alone does not retire a still-current request; its replacement may finish.
A new request ID for the same message, or the same numeric ID in another Thread,
can still reveal. An actual hook-plus-Legend controlled component test covers these
cases without changing the locked native fixture or claiming native acceptance.
