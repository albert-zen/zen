# Background Browser audit and targeted-input slice

Audit baseline: `b8d16bfed194e003bcf1238458f43c1cba365f95`.
Implementation and tests are a separate unpublished change. Source presence is
not installed-release or native-platform acceptance.

## What was already implemented

- Workspace and dedicated Electron DOM operations use an isolated CDP world and
  `Runtime.evaluate`, calling element click/value setters. They do not inject
  global mouse or keyboard input. At the baseline see `browser-provider.ts`
  lines 1993–2032 and `workspace-browser.ts` lines 1178–1188.
- Workspace disables background throttling. Unmounted pages temporarily attach
  to a transparent, offscreen, non-focusable window with `showInactive`; the same
  WebContentsView is returned to the user surface. See
  `workspace-browser-electron.ts` lines 18–24 and 60–89.
- The extension creates tabs with `active: false`
  (`resources/chrome-extension/service-worker.js:268`). Direct CDP target
  creation sets `background: true, focus: false`
  (`user-browser-provider.ts:2003–2008`). Neither route intentionally activates
  an existing tab for ordinary DOM actions or screenshots.
- Attached-browser capture uses `Page.captureScreenshot`, not
  `tabs.captureVisibleTab`. A hidden-surface timeout or malformed image has an
  explicit fallback status, not evidence that current pixels were captured
  (`user-browser-provider.ts:2194–2260`).
- Playwright uses a dedicated CLI session, native handle click/fill/press, and
  page screenshots. Its documented default is headless. ZenX does invoke
  `tab-select` within that session; code inspection alone did not verify all
  internals of the pinned CLI or its native focus behavior.

The earlier native macOS pointer probe only established the documented hidden
DOM click/type/select slice. Its report explicitly excluded the installed daily
app, external Chrome, Playwright, and Windows. Multi-browser connection/routing
work is not proof that all of those execution modes are background-safe.

## Confirmed gap and evidence limit

The baseline Browser backend had no coordinate-click or named-key API and the
extension bridge did not allow any CDP Input commands. Canvas/pointer-only and
keydown-dependent interfaces therefore could not use the Browser tool path.
The distinct Computer foreground tools were not a background replacement.

Workspace's mounted test only checks ownership/mounting; it does not branch on
hidden/minimized window state. This is an untested rendering condition, not a
confirmed capture defect: Electron's capture API can keep a hidden page
rendering while a capturer is present. No speculative reparenting change was
made. Native assertions now cover those states explicitly.

## Implemented slice

The new pointer-click/key-press tools are implemented for Workspace, dedicated
Electron and attached CDP, with one shared schema and narrow Input allowlist.
They use real screenshot/viewport coherence, page-local focus, opaque document
identity, exact host generation and existing session/control ownership.
Coordinates are CSS viewport coordinates, independent of image pixel scaling.
Ordinary target-page input remains background-available. The acceptance target
is an Agent-owned inactive tab while the user types in another tab or app;
`inputPolicy` exposes the native-surface limitation without making every ordinary
click foreground-only. Native dialogs/pickers require human control and do not
silently switch to global input.
A first dispatch consumes the observation only at the actual send boundary.
Stale/unsupported input rejects without switching to global input.

A click targets the same observed hit element and viewport across press/release;
a key can produce its own focus/scroll change. Detected extra trusted page input,
changed document or ownership fences stop the sequence. CDP acknowledgement
and exact Host fences authorize the planned release. A page-consumable DOM
listener cannot serve as an authoritative receipt: zero observed events after
an acknowledged press no longer strands the release or quarantines the tab.
More than one detected event still rejects. Consumed events do not prove the
absence of same-tab input; the simultaneous-user workflow uses separate tabs. An unconfirmed release produces
held-input quarantine, never an automatic retry or release into a new page.
A known release followed by navigation/control change remains explicitly unknown
without claiming a key/button is still held. Unsupported zoom/fallback capture
retains ordinary DOM observations but omits targeted-input metadata.

Playwright does not advertise these new tools in this slice. Drag, arbitrary
shortcuts, embedded frames, and identifiable native picker controls are not
supported. The probe also rejects labels associated with identifiable native
picker controls and requires human control, without a foreground fallback.

### Shadow support and capability limits

Open-shadow focus and pointer probes resolve the actual node, rather than its
retargeted outer host. A→B focus movement invalidates the observation, and native
file/color/date/select controls plus associated labels reject before any Input
command. Resolution is bounded to 32 steps; a per-document observer discovers
at most 128 open roots, visiting at most 8,192 elements per snapshot. Shadow
mutations and local scrolling invalidate captured layouts; new/untracked roots
never silently authorize an old screenshot.

Closed roots are not exposed by DOM APIs. Candidate tags only decide whether
additional evidence is needed; they no longer deny ordinary HTML. The trusted
backend retrieves the exact isolated-world node object and asks
`DOM.describeNode(depth: 0, pierce: false)` for actual shadow-root metadata.
Ordinary div/span/styled-button/contenteditable containers remain supported,
while known closed roots reject locally. References are allocated internally,
scoped to the same target/session, and released in cleanup. After cleanup the
server-returned backend node identity, metadata and fresh probe are rechecked;
no "no shadow" result is cached across actions. Supported input/canvas/button
leaves do not need these additional shadow queries. Optional missing evidence
removes only targeted-input metadata from a DOM inspection, not legacy DOM use.

The DOM and native metadata checks cannot be atomic with arbitrary renderer JS
and the later Input command. Changes detected within the bounded checks reject;
this does not guarantee that a page cannot change after the final response.
There is no repeated query loop, page pause or expanded permission domain.

Known probe refusals use a structured JSON result and one Host error code,
`BROWSER_INPUT_UNSUPPORTED`, with bounded reasons `native-surface` and
`shadow-surface`. Attached, Electron and Workspace preserve that boundary.
Unknown Runtime exceptions, including text that resembles this code, and
malformed metadata never count as a successful native refusal. Native smoke
asserts the actual public code/reason and independently requires zero Input.

The two new tools now own independent option-schema objects. Concurrent/multi
namespacing cannot rewrite a shared observe description twice; the regression
checks advertised tool references against actual tool names as well as runtime /
static-manifest parity.

### Trusted-input effects and strict-background limitation

- CDP trusted input grants page user activation. Arbitrary site handlers can
  call `alert`, `window.open`, `window.focus`, or invoke another picker. These
  effects cannot be inferred safely from the clicked element's appearance.
- Dedicated Electron denies native `window.open`. Workspace denies native
  popups and maps safe URLs into another Thread-owned tab. Neither is proof of
  complete native-dialog/picker/focus isolation; attached ordinary Chrome has
  no equivalent provider-enforced popup policy.
- Direct identifiable native controls and their labels are actively rejected.
  Known native dialogs reject targeted dispatch and require human control, with
  no automatic acceptance/dismissal. Arbitrary script effects are not promised
  to be universally blocked; native tests must report those limits separately
  from ordinary simultaneous background input.
- Existing DOM-click tools have a related site-controlled effect gap, now
  explicitly audited. Their pre-existing classification is not changed in this
  bounded patch. This is not grounds to deny ordinary exact-tab background input.
- Real smoke fixtures cover normal input defaults and direct picker rejection;
  they do not yet establish all alert/popup/window-focus behaviors. Native
  platform tests are pending. The capability limitation is surfaced in both
  model-visible schemas/metadata and documentation, not only in release prose.

## Final R3 follow-up

The final independent R3 on `dde7aaeb` requested two narrow changes; it was not
an approval. This follow-up fixes those cases without another review round:

- An attached action cancelled after acquiring a RemoteObject now releases only
  its recorded object IDs through a separate, 500 ms bounded cleanup send.
  Cleanup ignores the cancelled action signal and expired input/control check,
  but keeps the original connection generation, attachment epoch, session and
  document/context fence. It cannot attach to a successor or send Input, and an
  unknown release is not retried. Destroyed/replaced contexts receive no cleanup.
- The exact post-screenshot snapshot read now uses the same optional evidence
  boundary as initial DOM inspection. Missing/malformed shadow metadata and
  ordinary layout changes omit input metadata while retaining legacy DOM output.
  Original evaluation/confirmation, document, attachment, cancellation and
  publication fences still run; unknown errors are never native refusals.

The two original protocol reproducers were rerun before the fix: three cancelled
calls each allocated one object and sent zero releases, and two screenshot-phase
cases lost their DOM result. With only expected assertions updated after the fix,
all three cancelled calls sent one release with zero Input, and all three optional
evidence cases returned DOM output without input metadata. Fifteen added tests
also cover cleanup after inspect cancellation, successor isolation after
navigation/detach/reconnect, bounded unknown cleanup, and lifecycle/Runtime
failures that must still reject. These are protocol tests, not native acceptance.
The final 384 MiB semantic check covers both changed source files and the attached
regression test. Its first run diagnosed four test-only sync-or-Promise return
mismatches; normalizing those test values with `Promise.resolve` preserved the
assertions, and the same scope then passed. No full-application check was rerun.

## Validation

- Consolidated Browser/Workspace/attached-CDP/extension/provider regression:
  423 tests passed with serial test-file scheduling, process exit 0. This includes
  the expanded CDP-await interruption matrix, ordinary DOM/shadow metadata,
  node replacement/new closed roots at verification boundaries, and stable
  rejection versus unknown-error contracts. Existing navigation/cancel/takeover/
  extra-input/unknown assertions are retained. These are protocol/DOM fixtures,
  not native acceptance.
- Before the narrow R3 follow-up, first-party preparation completed, and the complete packaging suite passed
  5 tests including static/runtime manifest parity and offline tarballs.
  Playwright's unchanged tool surface is included in parity.
- Browser provider, attached CDP provider, and Workspace source passed a focused
  semantic TypeScript check at a 384 MiB heap, together with the shared input
  helper/tests and the attached-browser/parallel native smoke sources. Full application/test
  typechecking repeatedly exceeded cloud memory (exit 134/137); it is not passed.
- Real native gates are wired into CI. Windows inactive Chromium exercises
  Canvas click, Space insertion, Enter submit, Tab focus, ArrowDown scroll,
  direct/label file-picker rejection, foreground HWND and active tab. macOS
  Electron exercises unmounted/hidden/minimized pages with a focused sentinel
  window and unchanged physical pointer.
- The Mac/Windows parallel-input fixture and Windows Browser smoke now include
  seven additional real-CDP contract scenarios: consuming window handlers
  (stopPropagation and pre-tracker stopImmediatePropagation), ordinary open-shadow
  text/canvas, A→B focus, native controls/labels, known closed/deep shadow surfaces,
  and ordinary styled-button span, div pointer widget and contenteditable input.
  The runner checks 21 successful event pairs and 61 zero-Input rejections,
  including direct file/color/date/select inside a closed root. These are acceptance assertions, not observed native results.
  Both smoke entry points passed a focused 384 MiB semantic TypeScript check;
  their help, syntax/transpile, inline-JS parsing, formatting and import-isolation
  checks passed. Their native helpers and headed browser execution remain
  unverified here. It records CDP data isolation and
  real OS-input evidence separately; absent macOS AX permission is explicitly
  `partial-unverified`, never an OS-input pass.
- No native tests ran in the cloud audit workspace: Electron had no usable
  display and Chromium's process-singleton Unix socket was denied. No user
  computer was used and no display service was installed. Exact-build native
  evidence is required before claiming the simultaneous-user workflow succeeds.

## Primary references

- [Electron capturePage](https://www.electronjs.org/docs/latest/api/web-contents/#contentscapturepagerect-opts)
- [Electron sendInputEvent focus requirement](https://www.electronjs.org/docs/latest/api/web-contents/#contentssendinputeventinputevent)
- [CDP Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/)
- [DOM shadow-root visibility and permitted hosts](https://dom.spec.whatwg.org/#valid-shadow-host-name)
- [Chromium describeNode implementation](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/inspector/inspector_dom_agent.cc) (`describeNode` uses depth 0 and no node map; `BuildObjectForNode` includes `shadowRoots` and `shadowRootType` independently of child traversal depth). This is primary source verification, not a native run.
- [Playwright page focus model](https://playwright.dev/docs/pages#multiple-pages)
- [Playwright CLI headless default](https://playwright.dev/docs/getting-started-cli#headed-mode)
- [Playwright Chromium keyboard implementation](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/chromium/crInput.ts)

## Agent-created tab organization

The extension groups only newly Agent-created inactive tabs, scoped to its
current native connection and the actual browser window. Groups are ephemeral
visual metadata, not task authority. Existing user tabs, manually moved tabs,
and group names/colors are respected. A create success returns the target even
if grouping fails, including `grouping.status`; ordinary direct CDP reports
unavailable. Runtime `open observe:true` also preserves this creation metadata.
The extension requires `tabGroups` for metadata operations and must be reloaded.

## Native simultaneous-input evidence boundary

The native parallel fixture uses an owned disposable browser profile. Two CDP
streams prove target/data separation but do not alone prove that physical
keyboard focus is preserved. Native foreground HWND/PID, active-tab, and focused
element checks are recorded separately. Real OS typing is attempted only when
the native fixture has permission and its exact foreground target matches; no
permission prompts or settings changes are made. A missing macOS accessibility
grant leaves that OS-input layer explicitly unverified.

The owned Mac Chrome fixture explicitly enables renderer accessibility for its
strict native focused-element/value preflight; this condition neither grants OS
permission nor establishes AX readiness in an arbitrary user browser, and is not
a requirement of the production Agent CDP path.

Run the parallel fixture on an interactive test desktop with:

```
npm --workspace apps/zenx run smoke:browser-parallel-input
```

`ZENX_USER_BROWSER_EXECUTABLE` selects an existing test browser binary;
`ZENX_REQUIRE_OS_INPUT=1` makes unavailable real OS input fail acceptance;
`ZENX_PARALLEL_INPUT_ARTIFACT_DIR` preserves the JSON report. The script owns a
throwaway profile and native fixture windows. It never requests permissions or
changes security settings. Only fixture setup deliberately activates its own
windows; the measured Agent actions must preserve the foreground owner.

Extension 3.1.0 adds the `tabGroups` permission. The user must update/reload the
extension and approve any browser permission prompt; this code change does not
install, register, or approve the extension automatically. Group metadata waits
at most 500 ms after creation. A timeout returns the already-created target and
`grouping.status: "unknown"`: an already-sent native group command may still
finish, but ZenX will not follow it with renaming, regrouping, rollback, or a
duplicate create. Never interpret missing group acknowledgement as no tab or no
group having been created.
