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

## Opt-in first-acquisition diagnostic candidate

`ZENX_UIA_ACQUISITION_DIAGNOSTIC=1` enables a diagnostic-only experiment. The
candidate does not retry, warm up UIA, send WM_GETOBJECT, change COM apartments,
change focus, or change any native/parent timeout. It is disabled otherwise.

Counterevidence: after the message-loop readiness change in #443, integrated
[#442 run 38912838291](https://github.com/albert-zen/zen/actions/runs/38912838291/job/117012710811)
passed readiness tests and again failed initial inspect with
`provider_error_inspect_element_com_h80131505`, `not_dispatched` (smoke line 489).
Thus readiness is a valid prerequisite correction, not a UIA timeout root-cause fix.
The separate main-push startup harness PowerShell timeout is outside this candidate.

The native observer queries actual `CoGetApartmentType` before client construction
and before `ElementFromHandle`, records AutoSetFocus and connection/transaction
budget categories, and compares the native owner around acquisition without
publishing identity. Only fixed enums, booleans, schema constants and fixed-width
HRESULTs are emitted, after the original stdout receipt. Original exceptions are
rethrown unchanged. Native response bytes and transport options remain unchanged.
The parent keeps a strictly validated summary on failure before fixture cleanup.
No process IDs, handles, creation times, class names, titles, paths, memory values,
live numeric timeout values, or elapsed times are added to the diagnostic summary.

The fixture observes naturally received root-window WM_GETOBJECT messages using
DWORD-normalized UIA-root/MSAA-client/other categories. The UI thread updates
atomic flags and queues bounded background publications; it performs no diagnostic
file writes, synchronous stderr writes, provider calls, or waits. A background
snapshot is atomic and serialized. It is lower-bound evidence: even an existing
file may lag, and a write failure may prevent `observerFailed` from being persisted.
Missing data is unavailable, never proof of no message. Messages cannot be
attributed to this client; a nonzero return does not prove provider correctness.
Message-loop ticks do not prove provider readiness or continuous responsiveness.
Native timeout/abort before receipt settlement may leave no native observation.

Observer work can perturb scheduling and consumes time within unchanged existing
budgets. Exception isolation is not a claim of timing neutrality. This is an
instrumentation candidate, not a fix or evidence of a recoverable transient error.

Validation before a Windows experiment: exact-schema/privacy rejection tests,
disabled observer no-I/O test, read/sink fault isolation, original exception
identity, source-lock integrity, and synthetic Windows C# tests compiling the
actual fixture observer and dispatched-ready callback. Windows must also build the
patched native provider, verify the real CoGetApartmentType interop signature,
and run every existing packaged UIA acceptance operation unchanged. One explicitly
approved diagnostic-enabled Windows run can distinguish observed apartment,
owner mismatch, or message-entry-without-observed-return cases; success alone
cannot establish causality. No blind rerun or automatic retry is authorized.

Primary references: [UIA error codes](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-error-codes),
[CoGetApartmentType](https://learn.microsoft.com/en-us/windows/win32/api/combaseapi/nf-combaseapi-cogetapartmenttype),
[WM_GETOBJECT](https://learn.microsoft.com/en-us/windows/win32/winauto/wm-getobject),
[UIA threading](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading).
