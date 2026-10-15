# Test entry points

The repository has several independent verification boundaries. A focused command
is useful feedback, but does not replace the matching aggregate or platform smoke.

| Scope                           | Command                                                                      | What it prepares and checks                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Core, protocol, CLI, SDK, IMZen | `npm run check`                                                              | Formatting, Python lint, compiled TypeScript tests, Python tests, and IMZenX synchronization       |
| Node-only part of the root gate | `npm run test:node`                                                          | Builds the SDK and root TypeScript once, then runs SDK, IMZenX plugin, and Core/protocol/CLI tests |
| Root type diagnostics only      | `npm run typecheck`                                                          | SDK and root `tsc --noEmit`; useful without running tests                                          |
| ZenX                            | `npm run check --workspace @zen/zenx`                                        | Brand assets, first-party packages, Node/web type checks, all ZenX tests, and renderer/main build  |
| Standalone ZenX tests           | `npm test --workspace @zen/zenx`                                             | Prepares first-party packages before running the complete ZenX test directory                      |
| Standalone public SDK           | `npm test --workspace @zenx/plugin-sdk`                                      | Builds the SDK before testing its public API and external-package flow                             |
| Mobile                          | `npm --prefix apps/mobile test` and `npm --prefix apps/mobile run typecheck` | Mobile unit/contract tests and Expo TypeScript checks; install that app's own lockfile first       |
| Mobile/Host boundary            | `npm --prefix apps/mobile run test:host`                                     | Real TLS Host integration; also needs root dependencies                                            |

## Build once within an aggregate

The root Node test entry point always runs `npm run build`, which invokes `tsc`
with the same SDK and root configurations as `typecheck`. This is a type-checking
emit, not a transpile-only build. Therefore `check` does not run the identical
no-emit pass immediately before compiling those projects again. The standalone
`typecheck` command remains available.

Scripts named `*:prepared` require the immediately preceding preparation step in
the same checkout. They are internal composition points, not substitutes for the
standalone commands on a fresh checkout:

- SDK `test:prepared` requires SDK `build`.
- ZenX `typecheck:prepared` requires the SDK build (also performed by
  `prepare:first-party-plugins`).
- ZenX `test:prepared` requires `prepare:first-party-plugins`.
- ZenX `build:prepared` bypasses `prebuild`; callers must arrange the resources
  their build or package requires.

The ZenX aggregate prepares first-party packages once, then type-checks, tests,
and builds. The packaging test inspects all of those fresh tarballs, including
their npm file lists and provider variants, rather than compiling and packing
them again. The separate clean-source packaging test still proves that direct
packaging prepares the SDK without preexisting outputs. Portable packaging is separately self-contained: it creates an
isolated build snapshot and prepares plugin/provider resources. Its Windows
Project smoke must not build a discarded shared `apps/zenx/out` first.

## Preserve meaningful layers

Do not replace real package, process, browser, TLS, or operating-system checks
with mocks merely because unit tests cover similar names. They observe different
contracts. CI intentionally retains the real Playwright adapter, Windows attached
browser, WinApp, portable-package publication, Project lifecycle, and Android
Host/APK jobs, alongside the root and ZenX aggregates.

For large limits, test boundary arithmetic and admission against the actual
production helper with real boundary values, then use a small DOM fixture for
production controls and interaction wiring. Rendering a thousand full editors is
not necessary to prove a thousand-entry admission limit. Keep accessible names,
disabled-state assertions, stale-state guards, and representative full-view flows.

For cancellation and commit-fence tests, synchronize with the phase under test.
Do not start a short readiness deadline before unrelated package-manager work, or
use an SDK request deadline to stand in for a Catalog failure. Retain real process
and installer paths, reject early mutation failure, and release/abort/join every
fixture operation before deleting its temporary directory.

## Shell lifecycle observations

After `npm run build`, `node --test dist/test/shell-lifecycle.test.js` checks the
optional shell facts at the real process/task boundary. POSIX fixtures cover all
four foreground/stdio combinations, early foreground exit code, late output and
EOF, cancellation/timeout, signal exit, an escaped pipe holder, and journal
replay without resurrecting host-local tasks. Spawn failure and ordinary
spawn/exit fixtures run on every platform. Tests synchronize through fixture
files rather than treating output timing as process completion.

The root Linux aggregate runs these tests. The existing macOS capability and
Windows computer CI jobs also run the focused file; POSIX process-group tests
explicitly skip on Windows, where the current shell runtime only kills its direct
child. These checks do not claim Windows process-tree containment or portable
pipe-holder enumeration. A forced local stream destroy must remain `stdio: open`
unless both streams actually reported EOF.

## CI download and build caches

Android caches npm data using both lockfiles and Gradle data using the mobile
lockfile plus Expo app configuration, then uses Gradle's build cache. The native
packaging jobs cache only digest-addressed provider downloads, keyed by operating
system, architecture, and provider lock. Archive integrity is checked again on
use; application builds, staging directories, profiles, and publication outputs
are never shared through that cache.

These caches change repeated setup cost, not the nine platform and integration
gates. Report cold-cache and warm-cache CI measurements separately.

## Evidence when changing these gates

Record the tested commit, command, exit status, selected/pass/skip counts, and wall
time. Compare equivalent commands and disclose cold versus warm caches. A local
Linux pass cannot stand in for a Windows or macOS smoke, and a single faster run
is not a promised CI speedup. Do not remove assertions or introduce retries,
blanket timeout increases, or broad heap increases to make a failing baseline
appear green.

## macOS parallel-input consumption

The owned browser smoke's native event submission and Chromium's DOM/AX value
projections are asynchronous. A successful key submission is not a receipt that
both projections already contain the whole batch. Before the next macOS native
batch, and after the last one, a single two-second read-only barrier observes the
exact text issued so far. Only prefixes between the previously confirmed text
and that exact expectation can remain pending. Unexpected values, owner/focus
changes, cancellation, or an unsettled deadline still fail; no key is retried.
The native helper retains its immediate exact-value and per-event owner guards.

`nativeSettlementReads` records the barrier reads for each smoke layer. It is
zero outside macOS foreground native input. The pure boundary tests simulate
delayed projection, wrong values, timeout, cancellation and guard failure; the
ordinary macOS CI smoke must separately compile the Swift helper and exercise
actual OS input. This is fixture-consumption synchronization, not a product input
fix or evidence that intermittent CDP startup latency is resolved.

## Bounded macOS idle Accessibility sampling

The native parallel-input witness formerly made synchronous focused-window/title
AX requests on every 10ms timer tick. These requests run on the separate Swift
helper's main run loop, not the Node event loop. A single diagnostic pair on
2026-10-15 observed a 314.9ms AX read, a late Page.enable reply at 2168.5ms, a
1.5ms browser probe and a 1497.4ms renderer probe. This supports investigating AX
service contention; it does not prove all CDP timeouts share that cause. The
PID-only comparison stopped at a conservative frame-URL check before isolated
world creation, so it is not a complete controlled startup acceptance result.

Keep the cheap foreground PID/sentinel checks on the 10ms timer. Idle title reads
have a fixed 250ms quiet interval measured from completion, limiting idle AX work
to at most four reads per second without catch-up. Synchronous main-run-loop
execution already serializes these calls; no queued/concurrent worker is added.
While a synchronous AX read is running, that helper's timer and activation
callbacks can be delayed too; a 10ms timer is not a guaranteed 100Hz observation.
The interval bounds observer load, not a CDP deadline. Snapshots, value settlement
and every native event still perform the full uncached owner/title check. Their
mandatory reads are not throttled. The existing exact value check is unchanged.
`nativeTitleSamples` and `nativeIdleTitleCooldownMs` disclose the witness policy.

Sampling alone cannot establish that no very short ownership excursion occurred.
The fixture therefore retains window focus/blur history as well as its existing
visibility history. A same-PID window switch that returns to the original window
still fails the next comparison. Native activation notifications latch the PID
carried by the historical event even if foreground has returned. The callback is
bound to its guard epoch: explicit guard/reset removes the old observer and
invalidates already-queued callbacks; cooling down or returning focus never
clears drift. Normal setup completes before the history baseline is recorded.
The startup baseline precedes the first provider connect/list/open operation;
startup exit compares both histories before any scenario clear/reset. This
prevents a returned startup excursion from becoming the next valid baseline.
This adds no refocus, input replay, permission request or timeout relaxation.

Local deterministic slow-read models and source contracts verify load bounds and
unchanged dispatch guards; they are not native AX measurements. The macOS job
also compiles the actual Swift sampling/epoch functions with controlled clock and
ownership stubs, then compiles the full AppKit helper and performs ordinary real
input acceptance. A pass still requires the foreground native layer to report
`passed` with positive `nativeSettlementReads`; a skipped layer or one green
workflow cannot close every intermittent startup problem.

## Single-use background focus comparison (diagnostic branch only)

The exact-head #387 run 38703434208 passed the foreground native input layer
(18 settlement reads, 17 concurrent batches, 58 characters, 250ms idle AX policy)
but then rejected a new user-window focus event in the behind-sentinel CDP layer.
That layer concurrently sends fixture `Input.insertText` to the user page; its
old transport trace omitted that socket, so the last agent screenshot command
alone cannot establish causality. Chromium's
[InputHandler implementation](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/devtools/protocol/input_handler.cc)
calls widget focus before committing inserted text. This source-level lead is not yet
a native macOS reproduction of the isolated operation.

The separate `browser-focus-diagnostic.yml` workflow runs only on opening its
named same-repository draft branch, attempt 1, with an exact-head checkout and
read-only repository permissions. It runs capture-only then insert-only, each in
a new process and disposable browser profile, using the unchanged native helper.
It requires existing Accessibility trust and never requests permission. Normal
fixture setup activates only owned windows, then waits for the sentinel to own
keyboard focus and the user's actual renderer focus to be false before recording
the baseline. Each case sends exactly one subject command, records all browser,
user and agent CDP method/reply timing, and reads both page event histories and
native ownership immediately and after 200ms. Screenshot pixels are discarded.

Any rejected or outcome-unknown command stops that case and the pair without
replay or advancing to the other operation. Known focus/ownership changes remain
reported evidence, never acceptance. The report saves its baseline and each
completed after-read incrementally, including when a later read fails; the error
marks that evidence incomplete without discarding it or issuing more reads.
Cleanup confirms both owned child processes
exited before removing their temporary directory; unconfirmed cleanup is a
failure and retains it. Reports include checked-out head/tree, browser version,
fresh profile identity and cleanup status. This workflow does not replace or
weaken #387's existing background/native acceptance, and must not be merged.
