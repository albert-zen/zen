# First-inspect latency: one bounded observation

## Existing evidence and exact remaining failure

PR #395 head `f0f2f920` includes merged main `0d490b50` and all #387 fixture fixes.
CI [38710961739, Mac job 116341918728](https://github.com/albert-zen/zen/actions/runs/38710961739/job/116341918728) failed in `startup-agent-inspection`:

- `Page.enable`: 651 ms; `Runtime.enable`: 2192 ms, within the existing shared 10 s attachment setup.
- Main-frame navigation and stop-loading events arrived before inspection.
- `Page.createIsolatedWorld`: 232 ms; final `Page.getFrameTree`: 37 ms.
- At 09:14:07.311 UTC, socket 2, id 15 dispatched the **first full `browserInspectScript`**, in the newly created background Agent tab's isolated world. No reply preceded the 2 s outcome deadline.
- No input or screenshot had been dispatched; no subsequent lifecycle/closure event was retained. Browser PID was alive. The original report stopped tracing immediately on failure and contains no per-call AX durations.

The exact expression is 11526 bytes, SHA-256
`1ae368145e3e1f2650f52e283745385b9b9178e530efc9b15b27e6ef297c8c2a`.
It synchronously reads styles, bounding rectangles and `innerText`, and installs
transient identity/input-observation state. It does not await a timer or Promise.
The known fixture is small. This evidence identifies the command, not whether it
was queued, executing expensive layout, delayed by AX/browser work, or returning
slowly. #387 remains verified for its bounded fixture defects; it is not evidence
that every intermittent browser startup failure is solved.

## New observation, not production acceptance

One new draft PR's `opened` attempt 1 runs one fresh disposable Chrome profile on
macOS. Never rerun this observation to chase probability. #389 and #394 remain
stopped; neither old experiment is reopened.

- Use the current 250 ms idle AX sampler and existing full ownership guards.
  Passive start/end telemetry brackets the original `titleFor`; no extra AX
  snapshot is requested during the measured window. No sampling policy changes.
- Reuse the real synthetic smoke pages, Chrome flags and native helper. The
  diagnostic protocol replica follows marker-target creation, domain attachment,
  navigation, load events and frame/world barriers. Unlike ordinary acceptance,
  it performs no Agent readiness evaluation or later inspection workflow.
- Execute the current exported `browserInspectScript` byte-for-byte inside a
  `performance.now()` timing envelope. Keep its original `awaitPromise`,
  `returnByValue`, isolated-context selection and 2 s outcome deadline. Return
  only duration and bounded state/count metadata; no page text/values/images.
- At most one concurrent browser-scoped `Browser.getVersion` control query,
  dispatched only alongside the subject. Earlier setup unknowns send no probe.
  Persist subject timing/classification before waiting for this control query.
  A failed/unknown control makes the diagnostic exit nonzero without overwriting
  a successful subject result.
  Record Node event-loop delay, CDP command/reply times and passive AX timing.
- An unknown is immutable. Observe only that original response ID for at most
  another 5 s. Unknown/rejected outcomes exit nonzero; a late success/error is
  evidence, never a green diagnostic job or authority to advance. Earlier setup unknowns likewise stop the sequence. No second Agent
  evaluation, screenshot, input or renderer probe is sent.
- Persist stage/transport/AX records incrementally in a serialized NDJSON journal
  (1024 records / 1 MiB maximum), also emitted to job logs. Flush prior evidence
  before cleanup. A write error or 2 s file-write deadline blocks later stages;
  this is a storage bound, not a CDP timeout change. Confirm owned browser/helper
  exits before deleting the disposable directory. Retain it when cleanup cannot
  be confirmed. JSON binds exact HEAD/tree and expression/native-source hashes.

## Interpretation and stopping conditions

One success without reproduction ends the experiment. A short renderer duration
with long total RTT points outside the expression's measured body; a long body
duration includes synchronous layout/DOM work. It does not identify the precise
Chromium subsystem by itself. Node delays and temporal overlap with AX are
correlations only. A missing original reply leaves renderer execution duration
unknown, and must be reported as such. Failures before the subject are setup
observations, never proof about the inspect expression. No production timeout,
retry, safety gate or merge is changed by this diagnostic.
