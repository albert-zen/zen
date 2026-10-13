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
written UTF-8 file must agree. The provider then invokes a native button and
its independently written counter must become exactly one. The hook is drained
for another 200 ms before asserting no target/other activation and no pointer
movement. There is no focus restoration. This successful slice is printed
before the remaining negative cases run.

## Refusal and cancellation evidence

- A pre-aborted package call must cause no subprocess launch or editor effect.
- A fixture-only editor blocks inside the real native `WM_SETTEXT` operation.
  Cancellation starts only after that native entry marker appears. The actual
  production runner kills its child and waits for child/stdout/stderr close;
  the operation must reject with conservative `unknown`, and the observed
  native PID must no longer exist before the target is released. The target
  can still complete a dispatched side effect, which is why this is not
  reported as rolled back or `not_dispatched`.
- A genuine HWND-less ToolStrip control is read from the native inspection and
  submitted to the private transport. Its mutation must be `not_dispatched`.
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
