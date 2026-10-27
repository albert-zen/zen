# Computer operation contracts: bounded repair

This batch is layered on the exact-window #504 implementation. It does not replace
its native target binding or claim that a foreground tool is a background solution.

## Implemented

- Peekaboo targeted `computer_press` and `computer_set_value` are not certified
  focus-isolated. Both the published 1.0.2 variant and selected Host service label
  them `foreground_required`, require the existing foreground permission, and
  refuse before observation consumption or backend dispatch when consent is off.
  Existing/native AX semantics are not reclassified. No request is automatically
  converted to another tool or provider.
- Successful semantic backend returns carry `dispatch: completed` and
  `applicationEffect: unverified`. This means the backend call returned, not that
  the app accepted the input or the business task succeeded. #504 native foreground
  receipts retain `dispatch: posted`. No automatic input replay is introduced.
- Peekaboo forwards the existing stopping callback. External runner abort, timeout
  and bounded-output failure request termination once and retain their operation
  and launch lease until child/pipe close. Failed kills, an exit without close,
  and error events do not retire the operation or clear its activity indicator.
  Cancellation during launch preparation is checked again before spawn.
- Missing close leaves the exact operation pending/stopping. It does not become a
  successful cancellation, start another operation, accumulate diagnostic output,
  or introduce a retry/watchdog scheduler. Existing Host shutdown remains separate;
  this provider promise is not proof of OS termination.

## Synthetic acceptance

`computer-operation-contracts.test.ts` verifies both mutation tools: disabled
consent gives zero dispatch; native AX retains background classification; paint
precedes input; stopping remains until settlement; application effect is unknown;
revocation during the notice gives zero input; static and runtime manifests agree.

`external-provider.test.ts` uses synthetic EventEmitter children to cover
abort/timeout/output-limit crossed with kill returning true/false/throwing/emitting
an error, late close, exit without close, one stopping callback and one lease
release. It also covers cancellation during lease acquisition, synchronous spawn
failure and a failed presentation callback. All these tests run without a user's
applications, desktop input, paid API or real DingTalk/WeCom data.

The existing `preview-foreground-activity.mjs` builds the actual production
`foregroundActivityHtml` renderer into a self-contained synthetic preview and
records its source hash. A browser screenshot of it demonstrates presentation
only, not a native focus, physical Stop-click, lock-screen or power-state guarantee.
No renderer layout was changed in this batch.

## Explicit remaining boundaries

- The original reported foreground jump cannot be attributed to Peekaboo without
  the actual provider/version/call trace. This fixes a verified contract hole,
  not a claimed reproduction of that incident.
- Native AX can cause the application itself to open dialogs or request focus.
  An accessibility API success is not evidence that this did not happen.
- Display off with an unlocked awake session, locked session, whole-machine sleep,
  and an invisible/minimized window are different capability states. This batch
  adds no wake/unlock/power-setting path and does not promise any state works.
  A future readiness check must reject unavailable/unknown required conditions,
  not bypass the OS or mislabel transport success as usable desktop input.
- Native inspect budgeting/OCR fallback, explicit Unicode clipboard APIs, retained
  screenshot artifacts and latest-reference ergonomics are separate bounded work.
  #504 supplies native Unicode typing and logical shortcuts, but this batch does
  not extend those guarantees to Peekaboo or another provider.
- Shell/osascript does not automatically inherit the Computer admission/indicator
  contract. This batch does not claim universal OS automation interception.

## Independent-review correction: bounded readiness and blocked Quit

Waiting for child close exposed a shared-runner integration defect: an unclosed
Peekaboo/Playwright probe could prevent startup from reporting a result, and
bootstrap join or provider cleanup could indefinitely prevent Quit from reporting
failure. The operation itself still must not be marked settled on a timer.

`waitForLifecycle` only bounds the observer. Readiness probes retain their native
5/10-second deadlines and allow one additional second for close, then fail with
`LifecycleWaitUnconfirmedError` instead of substituting another provider. The
original probe is cancelled too, fencing delayed launch preparation; its lease
still releases only on real close (or confirmed zero-spawn failure).

Quit observes bootstrap join and Host cleanup for five seconds per phase. An
unconfirmed phase blocks Quit: the standard localized error dialog explains that
the process has not exited and no automatic force termination occurs. Existing
stopping indicators and source promises remain owned. Repeated Quit observes the
same promises, unwrapping historical typed readiness failures within the current
phase's single absolute deadline rather than consuming another Quit or resetting
the budget. It does not call stopHost again and does not repeatedly display the
same dialog. Late settlement alone does not quit; a subsequent explicit Quit can
complete. Confirmed ordinary shutdown failures retain the previous error path.

`external-provider-host-lifecycle.test.ts` exercises the production provider,
bootstrap and Host lifecycle classes with synthetic children, including real
probe/cleanup deadlines, failed kill, delayed lease acquisition, both providers,
startup without fallback, blocked Quit, late close, repeated Quit and no replay.
No native applications or user desktop are involved.

## Native target lifecycle repair (2026-10-27)

This stage builds on the explicit native OCR checkpoint, preserving its existing
owner/target/capture/expiry checks and all-capture invalidation on attempted input.

- Native target transport now uses one termination path for abort, timeout,
  malformed/oversized output, pipe/process errors and explicit close. A failed
  kill, thrown kill, or error emitted while killing does not settle the call;
  stopping activity remains through `exit` and late output until actual `close`.
  Termination is requested once, not retried. No helper restart or input replay
  is introduced. This uses the existing process lifetime, not a new ledger.
- Mutation replies must contain `dispatch: posted` and
  `applicationEffect: unverified`. A `{result:{}}` envelope is not a success:
  native transport terminates and waits for close, then reports unknown input
  outcome. Session-level validation also refuses malformed injected receipts.
  It never claims the action did not happen. Read-only select/verify cancellation
  remains a read-only unknown result, not a claim that desktop input was sent.
- Closing a target session fences late selection before publication. Capture
  checks cancellation, target identity and a local capture generation before
  queuing verification and after verification. Input or explicit invalidation
  fences already-acquiring images as well as already-stored images. Old failed
  calls do not clear a newer explicit selection.

Fresh synthetic regressions reproduce ten session/receipt failures on the
unchanged OCR checkpoint before the fix. The expanded transport matrix covers
32 combinations (eight failure sources and four kill outcomes), exercising the
production `ForegroundActivity` owner. Existing real child-process fixtures test
malformed replies and process closure; new capture tests cover close, target
replacement, cancellation, input and explicit invalidation. The macOS CI lane
runs the same lifecycle and capture suites alongside the native bound-input and
real synthetic-pixel Vision checks.

No UI layout, foreground consent, native activation, screen-power policy,
clipboard channel, screenshot TTL or provider routing changes are included.
These tests do not establish DingTalk/WeCom behavior, physical Stop clicks,
sleeping-display/locked-session input or arbitrary third-party acceptance.
