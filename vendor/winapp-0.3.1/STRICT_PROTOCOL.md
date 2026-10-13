# Private strict UIA protocol, version 1

This is the downstream `zenx-winapp-0.3.1-af0.2` protocol. Stock WinApp CLI commands
do not enter this path. Start the reviewed binary with exactly one argument,
`--zenx-uia-strict`, and write one UTF-8 JSON object followed by stdin EOF.
Requests are limited to 256 KiB. Unknown, duplicate or missing fields are rejected.

## Requests

Inspection has exactly `schemaVersion: 1`, `operation: "inspect"`, `hwnd` (canonical
positive decimal string), and `pid` (positive integer). The HWND and PID come from
the existing window listing. Inspection never resolves a title, process name,
selector, alternate window or ancestor.

Actions have exactly `schemaVersion: 1`, `operation: "invoke" | "set_value"`,
`root`, and `control`. Only `set_value` also has `value`: a Unicode string of at
most 4000 UTF-16 code units. Pass the complete root/control identities returned
by inspection without editing, rounding, omitting or inventing fields.

`root` contains:

- `hwnd`, `pid`
- `processStartTimeTicks`: canonical decimal .NET UTC creation-time ticks
- `className`: native Win32 class
- `runtimeId`: complete UIA integer array, 1–64 entries

`control` contains:

- `hwnd`, `pid`, `nativeClassName`, `runtimeId`
- `name`, `automationId`, `className` (UIA), `frameworkId`, `controlType` (integer)
- `bounds`: `left`, `top`, `width`, `height`, all exact integers
- `enabled`, `offscreen`, `password`, `invokePattern`, `valuePattern`: booleans
- `valueReadOnly`: boolean if ValuePattern exists, otherwise null

Identity strings are limited to 1024 UTF-16 units, without truncation. HWND `"0"`
may appear for readable virtual controls; these cannot be action targets.
Inspection covers at most 256 controls, depth 32 and 2048 traversal visits. An
incomplete, duplicate, failed or over-limit walk returns a refusal, not a partial
actionable tree. No current text value or password value is included in inspection.

## Responses

Every response has these fields:

```json
{
  "schemaVersion": 1,
  "contractVersion": 1,
  "providerBuild": "zenx-winapp-0.3.1-af0.2",
  "upstreamCommit": "c8ada4a403c43b96780b87abc454cba51f649c60",
  "autoSetFocus": false,
  "operation": "inspect",
  "outcome": "completed",
  "error": null
}
```

`autoSetFocus` is a live service-client readback; null means no successful readback
was available. `operation` is null when request validation did not finish. A
completed inspection adds `root` and `controls`. A completed SetValue adds `value`
with the full exact readback, including an empty string. Completed Invoke adds
nothing. Refusal/error responses add no payload fields. Responses are at most
2 MiB plus their terminating newline. All successfully written protocol responses
exit zero; consumers must inspect the outcome and exact contract, not the exit code.

- `completed`: inspection finished, Invoke returned, or SetValue returned and
  exact ordinal full-Unicode readback matched.
- `not_dispatched`: no mutating pattern call was entered.
- `unknown`: the mutating call may have run. Includes exceptions from that call,
  failure to obtain full readback, and readback mismatch. Never retry automatically.

An absent, truncated, invalid or cancelled action response cannot establish
`not_dispatched`. Errors contain only controlled labels; no provider exception
text or entered value. Representative labels are `bad_request`, `root_changed`,
`control_changed`, `native_identity_required`, `native_identity_not_unique`,
`pattern_unavailable`, `control_ineligible`, `readback_mismatch`, and `provider_error`.

## Dispatch boundary

The strict command uses the same registered CsWin32-generated `IUIAutomation2`
client as the feature probe, configured with AutoSetFocus FALSE. Each action checks
the exact top-level root, native ancestry, PID/process creation, native class,
UIA RuntimeId and complete semantic/geometry fingerprint. It requires exactly one
native-HWND match, compares it with ElementFromHandle, and verifies raw UIA ancestry.
Final validation repeats uniqueness and reads live AutoSetFocus FALSE immediately
before one InvokePattern or ValuePattern call on the verified element. There is no
name/selector fallback, ancestor action, alternate pattern, focus call, restoration
or input injection. SetValue reads back through the same value pattern.

These checks do not make provider behavior atomic or prevent a provider from
changing or activating itself during a call. Foreground observation and result
classification remain separate transport responsibilities.

The narrow source tests prevent accidental fallback/contract regressions and
verify patch structure. They do not establish C# compilation, generated COM
interface compatibility, NativeAOT viability or real Windows UIA behavior. Those
require the pinned Windows build and packaged-provider smoke fixture.
