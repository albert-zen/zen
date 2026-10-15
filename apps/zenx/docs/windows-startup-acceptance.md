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
