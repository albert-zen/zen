# Packaged nonactivating Windows UIA acceptance

The ordinary packaged-provider smoke runs `verifyWindowsPackagedUiaSmoke` on
Windows. It must run inside the packaged Electron application with the real
`process.resourcesPath` and the compiled manifest digest. There is no PATH,
unpackaged, mocked-provider, or skipped-native-fixture success path.

The gate selects `zenx-winapp-uia` through the production provider catalog,
checks its verified diagnostic, and invokes the actual
`ComputerZenXCapabilityPackage` with foreground control disabled. A foreground
activity tripwire fails if semantic operations attempt to enter the overlay
route. The existing stock-provider foreground-consent and strict native-capture
smokes are separate and unchanged.

## Native evidence

The bundled smoke embeds a disposable PowerShell/C# WinForms fixture, avoiding
any dependency on checkout files. The target and the foreground guard are
separate native processes. During fixture setup only, the guard is explicitly
activated. Before the action epoch, it installs an `EVENT_SYSTEM_FOREGROUND`
hook and starts 5 ms foreground/pointer samples. Every observed foreground
event is retained; overflow, unavailable hooks, missing native controls, fixture
exit, or missing effect files fail the smoke.

With the guard foreground, the packaged provider writes a complete string with
Chinese characters, an emoji, quotes, a backslash, and a newline to the native
editor. Both the provider's full readback check and the target's independently
written UTF-8 file must agree. The target's existing UI timer reads the actual
multiline editor text and writes only changes, including its first observed
empty value, with no BOM or newline normalization. It does not depend on
`TextChanged`: [Windows documents that multiline `WM_SETTEXT` does not send
`EN_CHANGE`](https://learn.microsoft.com/en-us/windows/win32/controls/en-change).
Timeout diagnostics contain only bounded lengths and first differing UTF-16
code units from the synthetic fixture text; full-string equality is unchanged.
The provider then invokes a native button and
its independently written counter must become exactly one. The hook is drained
for another 200 ms before asserting no target/other activation and no pointer
movement. There is no focus restoration. This successful slice is printed
before the remaining negative cases run.

## Refusal and cancellation evidence

The target's atomic `target.json` receipt is published from a posted
`BeginInvoke` callback, after the owning UI thread dispatches it. The parent
requires that dispatch evidence before starting the guard. This proves message
processing, not UIA provider availability; the first production inspect still
has to succeed without warm-up calls, retries, or a changed timeout. The Windows
readiness contract test compiles the actual callback registration with a paused
synthetic dispatcher. It proves publication ordering, not native UIA behavior.

On failure, the smoke retains a bounded diagnostic in the job log before
releasing and closing its fixtures. It includes the current fixed phase, up to
eight native transport durations/outcomes, child PID/exit observations and up to
24 numeric target samples. The target's UI timer and `WM_GETOBJECT` handler only
update atomic counters; a bounded background thread serializes samples to its
private stderr pipe. The original `WndProc` runs exactly once, with its return
value and exceptions unchanged. There is no UI-thread diagnostic I/O, injected
probe message, UIA warm-up, retry, extra timeout or focus restoration.

The samples independently read counters and may be stale or absent; they do not
prove continuous responsiveness, UIA readiness or operation success. An entered
but not yet exited `WM_GETOBJECT` differs from a handler that returned while the
client still timed out. Object IDs are limited to UIA root (`-25`), MSAA client
(`-4`) or other (`0`); no title, text, HWND, request body, environment or raw stderr
is copied into this diagnostic. Native-call duration includes the production
transport's verification and process lifecycle, not only the COM call. The
Windows observer contract test deliberately blocks the diagnostic writer and
checks unchanged synthetic dispatch/exception behavior; only packaged Windows
CI can establish real native behavior.

- A pre-aborted package call must cause no subprocess launch or editor effect.
- A fixture-only editor blocks inside the real native `WM_SETTEXT` operation.
  Cancellation starts only after that native entry marker appears. The actual
  production runner kills its child and waits for child/stdout/stderr close;
  the operation must reject with conservative `unknown`, and the observed
  native PID must no longer exist before the target is released. The target
  can still complete a dispatched side effect, which is why this is not
  reported as rolled back or `not_dispatched`.
- Genuine HWND-less ToolStrip controls remain in the native inspection, including
  at least one actual anonymous structure row with an empty RuntimeId. Empty
  identity is accepted only for these read-only HWND0 rows; the full bounded
  subtree is still traversed, and the host gives them no actions or capture
  continuity identity. Native children keep their full exact identity.
- Both Invoke and SetValue on an anonymous row must be `not_dispatched`, as must
  Invoke on the real virtual ToolStrip item. Empty root/native identities and
  null, oversized, or fractional RuntimeIds are rejected as malformed requests
  before constructing UIA. This JSON matrix does not simulate corrupt COM
  SAFEARRAY shapes or anonymous cycles; source-contract checks cover their
  validation and traversal-budget branches separately.
- The editor HWND is destroyed and replaced, with both handles briefly alive
  to avoid handle reuse. The old native identity must be `not_dispatched`.
- A second same-process window with the same title is shown after the focus
  epoch. Actual provider target resolution must refuse that ambiguity.

All private-transport cases reuse the production launch's packaged asset
verification/binding, not a standalone untrusted executable. The runner trace
only observes native calls and forwards their actual options and results.

The evidence proves this disposable fixture epoch, not a universal focus
promise: an application's own behavior and target changes around final
validation can still affect focus. Linux unit checks validate the evidence
checker only; Windows packaged CI is required for the native claims above.
