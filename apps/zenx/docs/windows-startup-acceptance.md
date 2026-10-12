# Windows startup acceptance (#167)

The startup surface already exists. This harness does not add a window, renderer,
startup flag, production hook, or security exception. It observes the existing
portable application on a real Windows desktop, holding its existing awaited
bootstrap fence while the first window renders and a second process launches.

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

CI reuses the portable package already built by the Windows Project workspace
smoke job. `zenx-windows-startup-evidence` is uploaded even if the startup step
fails. Inspect `report.json`, not just the green job. `workflowCommit` is the
checkout commit (a PR workflow normally tests a merge ref).

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
