# Windows startup acceptance (#167)

The startup surface already exists. This harness does not add a window, renderer,
startup flag, production hook, or security exception. It observes the existing
portable application on a real Windows desktop, holding its existing awaited
bootstrap fence while the first window renders and a second process launches.

## Windows checkout correctness

The first hosted run observed real startup/success (428.5ms to `WS_VISIBLE`, same
HWND, second-launch foreground ownership, Host ready), but its failure case timed
out. These are partial results from head `6148c586`, not complete acceptance.

A subsequent deterministic regression reproduced a strict-CSP mismatch when the
appearance bootstrap input has Windows CRLF line endings. HTML parsing normalizes
CRLF and CR to LF before the browser hashes inline script text; hashing the
unnormalized input can block the script that changes status into the actual error
page. `startupScreenHtml` now normalizes the emitted script before hashing it.
The strict script policy is unchanged. LF/CRLF/CR inputs produce identical HTML
and the hash matches the parsed script. See the [HTML preprocessing rule](https://html.spec.whatwg.org/multipage/parsing.html#preprocessing-the-input-stream)
and [CSP hash matching](https://www.w3.org/TR/CSP3/#match-element-to-source-list).

This is a confirmed source-level defect. The initial hosted failure's exact cause
was not independently established. The harness now prints bounded
failure diagnostics (events/stdout/stderr), observes the startup page before image
capture, and records renderer console/load errors. It does not relax the failure
assertion or timeout.

## Run

On Windows, from `apps/zenx`, build the normal package using the existing approved
provider-lock/download setup, then run:

```powershell
node ./scripts/package-zenx-portable.mjs --app
./scripts/windows-startup-acceptance.ps1
```

Or pass `-PackageDirectory` for an existing **unpacked, unsigned test package** and
`-EvidenceDirectory` for a fresh output directory. Do not use an installed app or a
signed release as the fixture. The script requires a new evidence directory and
leaves JSON, logs and PNGs there. It removes only its temporary package/profile
copies. It creates two isolated fake-provider profiles and makes no model calls.

CI reuses the single portable package already built by the Windows bundled-provider
smoke job and used by its Project workspace acceptance. It retains that job's
same-run downstream provider digest and trust evidence; no second packaging job
or provider build is introduced. `zenx-windows-startup-evidence` is uploaded even if the startup step
fails. Inspect `report.json`, not just the green job. `workflowCommit` is the
checkout commit (a PR workflow normally tests a merge ref).

## Prior native evidence

[PR #295 run 38267587608](https://github.com/albert-zen/zen/actions/runs/38267587608/job/114873549111)
at head `75494349057942cb3d49c5266e74bf4909e97748` completed both native cases
on Windows Server 2025 / Electron 43.2.0 / x64:

- Success: 553.4ms to first visible HWND; actual gate held 3051ms; Host ready
  and the mounted renderer retained the same sole HWND. Second launch restored
  the window and changed foreground ownership to that HWND.
- Failure: 529.3ms to first visible HWND; actual gate held 3021ms; the same sole
  visible HWND exposed the exact synthetic failure as inert alert text. Second
  launch restored it; foreground was already that HWND before the launch.
- Raw event arithmetic matched the reported holds; cleanup, finalization, and
  `nativeSampleGaps` arrays were empty. These are historical log/report receipts,
  not a claim that screenshots were visually inspected or that the current
  integration has already passed native CI.

The earlier 1856.5ms sample remains a miss against the approximate one-second
observation target. Earlier advertised three-second holds were invalidated by
PowerShell timestamp stringification losing fractional seconds; the final run
above used the corrected UTC DateTime conversion. Neither a single successful run
nor these two samples establishes a universal timing guarantee.

## Presented renderer evidence

The current run at head `5a2256c4349d177acaf4571a9402e68f1fe79ec7`
([artifact 11981327517](https://github.com/albert-zen/zen/actions/runs/38750698525/artifacts/11981327517))
passed native HWND/Host checks but its final `renderer-loaded.png` is a uniform
1024×720 canvas (`#e8eaf1`). That receipt does **not** establish visible final UI.
The original evidence remains retained; the earlier `#root` child-count check
proved DOM mounting, not presentation.

Success acceptance now observes the existing window's real presentation frames
through Electron `beginFrameSubscription(false, ...)`, retaining the original
30-second renderer deadline. The fixture requires the real app shell and both
visible, unobscured New Thread/Settings text labels in the current `index.html`.
Their direct text-node Range bounds exclude icons, shortcut hints and button
backgrounds. The labels' computed visibility, opacity, text color/fill and font
must permit visible text; each text crop needs contrast across at least eight
pixels in multiple rows and columns, not isolated icon pixels. Contrast counts
are relative to the crop's dominant color, never its first pixel: an isolated
bright or dark corner must not invert background pixels into text evidence.
Captured light/dark UI label pixels are retained only as unit-test samples;
they are not Windows acceptance evidence for this PR.

A ready DOM observation precedes the candidate presentation. Another observation
must match its text geometry/style, app-shell bounds, viewport and DPR exactly;
any presentation arriving during that query invalidates the older candidate.
Navigation or loading changes fail closed. Read-only baseline polling stays
inside the original deadline and does not request paint. The fixture saves the
verified frame directly, never a later recapture. The event contains only fixed
selector/text-presence/contrast/pixel-count and image-size facts; no DOM text is
recorded. The first rejected nonempty frame may be retained for diagnosis.
Navigation, renderer/window loss, bitmap errors, timeout and subscription cleanup
failure all fail closed. The harness independently requires the presentation
receipt. No product source, show/focus behavior, timing target or deadline changes.

DOM geometry and pixel contrast are bounded acceptance checks, not OCR or proof of
what a physical monitor displayed. The new native screenshot still requires
visual review. [Electron presentation-frame documentation](https://github.com/electron/electron/blob/v43.2.0/docs/api/web-contents.md#contentsbeginframesubscriptiononlydirty-callback)
distinguishes presentation events from navigation/load completion.

## What is exercised

- Copy the ordinary portable artifact to a new temporary directory. AST-check
  that the compiled main contains exactly one awaited `bootstrapFence.run` call
  with `bootstrapZenX`; refuse changed/duplicate/missing/already instrumented seams.
- Add a test-only observer and asynchronous gate at that call's existing callback.
  The original window creation, single-instance lock/activation, bootstrap body,
  cancellation fence, renderer transition and outer error handler still execute.
  Production source and the original artifact are unchanged. The two main-file
  SHA-256 values in `instrumentation.json` disclose the altered fixture.
- Measure process `StartTime` to the first externally enumerated PID-owned native
  `WS_VISIBLE` HWND, sampled roughly every 20ms. Require exactly one window and
  match it to Electron's native handle and actual startup status content.
- Hold bootstrap at least three seconds. Minimize that window through Win32,
  launch the same executable/profile again, observe the actual single-instance
  event and secondary exit, and require restoration of the same HWND.
- Separately record `GetForegroundWindow` before/after second launch. Only exact
  HWND equality records focus as `observed`. No synthetic activation event,
  foreground permission grant, input injection or focus-policy bypass is used.
- Release success into the real Host bootstrap; require Host `ready`, a mounted
  normal renderer, the original HWND and only one created BrowserWindow.
- Release failure by throwing an explicitly synthetic error at the bootstrap
  boundary. Require the existing error page, exact inert error text and original
  visible HWND. This is outer-bootstrap failure acceptance, not every possible
  internal Host/provider failure.

Screenshots are renderer captures paired with external native visibility checks;
they are not desktop photographs. No remote debugging port or renderer security
change is needed. Unit tests exercise source transformation and private staging;
they do not substitute for the Windows execution.

## Reading results honestly

`firstVisibleMilliseconds` includes Electron startup and test instrumentation,
OS scheduling, and polling/Start-Process observation overhead. `withinOneSecond`
is an observation against the issue's approximate target, **not a CI timing
assertion or a universal one-second promise**. There is one success and one failure
sample, no statistically meaningful percentile. Renderer capture proves rendered
content; `IsWindowVisible` observes the style bit and can be true while another
window obscures it. First light on a user's monitor remains a manual acceptance
check. Instrumented timing is not a pristine shipping-binary benchmark.

If foreground focus is not observed, `focus` remains
`unresolved`. The raw foreground handles preserve the gap for investigation;
OS policy and a product regression are both possibilities.
Restoration is still mandatory. A passing smoke with that value does **not** close
the focus criterion. Do not close #167 merely because CI is green. Record native
measurements and inspect screenshots, then retain any timing/focus/manual gap.

Official guidance used for these distinctions:

- [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window):
  `ready-to-show` occurs after first rendering; `show: false` is not immediate
  process-to-visible feedback. Native handles identify the physical window.
- [Electron single-instance lifecycle](https://www.electronjs.org/docs/latest/api/app#apprequestsingleinstancelockadditionaldata):
  a real second process forwards activation to the owning process.
- [Windows IsWindowVisible](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-iswindowvisible):
  visibility style is not proof that the window is unobscured.
- [Windows GetForegroundWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getforegroundwindow)
  and [foreground restrictions](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow):
  record actual foreground ownership rather than equating a focus request with
  successful activation.

## Product readiness follow-through (2026-11-05)

The existing first-shell gate is deliberately retained. It can pass while the
sidebar says "Waiting for the local App Server" and the main view says "Starting
Zen App Server". This was observed again in the unmodified main `d8e83eca`
[run 42055431818](https://github.com/albert-zen/zen/actions/runs/42055431818),
[artifact 13429507378](https://github.com/albert-zen/zen/actions/runs/42055431818/artifacts/13429507378).
Its matching ZIP digest is
`ba008b64b09dc27b66d1f8f859ce3ce5285dcf843e3ce99a01ad6a3246ba2095`.
That run observed 512.5ms/624.2ms initial success/failure visibility, successful
same-window restoration, main Host readiness and explicit failure text. It did
not measure usable history. These remain historical results, not results for the
following enhancement.

Success now seeds one completed, explicitly synthetic conversation before
launch, using the ordinary Host, durable ItemList/Trace and local fake provider.
A fresh data directory is mandatory; existing data is refused. No user profile,
credential, external model or tool execution is used. The seed receipt contains
only synthetic IDs/content and the fake response's generated timestamp context.
The failure scenario remains unseeded and keeps the original outer-bootstrap
failure checks.

After `renderer-loaded.png`, the same original 30-second acceptance deadline
must also cover:

1. `sidebar-ready.png`: the seeded conversation title and enabled New thread
   label are visible, unobscured and have text pixels in an actual presentation
   frame. Waiting, loading and error sidebar states cannot pass.
2. A scripted DOM click on the exact seeded row invokes the real React selection
   handler. This is product interaction coverage, not native mouse/input proof.
3. `conversation-ready.png`: that exact row is selected and the persisted user
   and fake-assistant messages have matching text and visible text pixels in the
   same accepted presentation frame. The earlier shell image cannot satisfy this
   gate. The verified frame is saved directly, without recapture.

`report.json` separates process-to-first-window, main Host ready, first shell,
sidebar readiness and first conversation content. The latter timings include the
intentional bootstrap hold, whose duration is reported alongside them. They are
bounded synthetic portable measurements, not pristine startup benchmarks,
percentiles, large-history performance measurements or installed-release results.
Both later stages must retain the sole original HWND; any observation timeout or
failure fails the scenario rather than reporting product readiness.

There is no NSIS/MSI/MSIX installer build in the current checked workflow/scripts.
This enhancement does not create or install one and cannot close the real
installed-Windows scope of #167. That scope needs a separately identified release
artifact in an isolated Windows VM. Retain #167's installation/performance scope
until that evidence exists. Review the new native screenshots before claiming
this enhancement passed; local unit tests are not Windows acceptance.

### First product-readiness run and observer correction (2026-11-06)

[Run 42147269551](https://github.com/albert-zen/zen/actions/runs/42147269551)
for PR #722 head `d40d4bc9` failed the conversation presentation deadline after
successfully observing the sidebar. Its initial window appeared in 414.2ms,
retained HWND 459242 and gained foreground on second launch; the measured hold
was 3031ms. The failure scenario did not run. The original
[artifact 13471036597](https://github.com/albert-zen/zen/actions/runs/42147269551/artifacts/13471036597)
ZIP SHA-256 is `b147ea733b8870d87ca5d2c6fbdf6826662929866104f2afefdc6c645d7455c1`.
These partial results are not full product acceptance.

The product observer now distinguishes zero-width newline layout rectangles
from glyph rectangles. Exact complete text, a nonempty set of positive glyph
rectangles, bounds, occlusion and pixel evidence remain mandatory; malformed
geometry still fails. A focused regression failed before this correction and
passed afterward. This demonstrates the observer boundary defect, not the
historical Windows timeout's unique cause. Failed product stages now retain
fixed selection/range geometry in `*-rejected-dom.json`, explicitly marked
`accepted: false`; this is diagnostic data, never presentation acceptance.
The original deadline and screenshot acceptance rules are unchanged. Fresh
Windows receipts and screenshot inspection are still required.

[Run 42148987445](https://github.com/albert-zen/zen/actions/runs/42148987445)
for head `8a2a1d7b` again failed the conversation gate. Its diagnostic confirms
`ready: true`, one presented frame, a zero-width newline rectangle, and a
3.84375px trailing-whitespace rectangle with no glyph pixels. Replaying the
actual rejected image against the pixel validator fails with that whitespace
crop and succeeds when only that crop is omitted. The observer therefore now
samples every non-whitespace run in the exact complete text. It does not drop
words, relax pixel thresholds or substitute a DOM-only check. The regression
fails before this change and passes afterward.

The matching
[artifact 13472306364](https://github.com/albert-zen/zen/actions/runs/42148987445/artifacts/13472306364)
ZIP digest is `3e7bb22cf194e177ccfdd260230625822310d0a33b795da94e22289cc7a13c93`.
Initial visibility was 404.9ms, the hold 3013ms, and original HWND 524486 regained
foreground. The failure scenario did not run. The actual rejected conversation
image shows the synthetic messages, but also a trusted-document sidebar error
and background-command status error. Those observed errors remain unresolved;
this fixture-only correction does not change production trust checks or claim
the broader product is accepted. Fresh native acceptance remains required.
