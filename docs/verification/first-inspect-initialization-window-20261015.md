# First trusted inspection within the original initialization window

## Evidence and policy boundary

The single stopped [#419 observation](https://github.com/albert-zen/zen/pull/419)
failed its first main inspection at the existing two-second outcome boundary.
Its original, same-route reply was observed 3728.182 ms after send returned.
The timer callback was only 2.424 ms late. No earlier abort, route mismatch,
attachment teardown or socket close was observed. The attachment's original
initialization deadline still had 4471.287 ms remaining at dispatch; the reply
arrived 743.105 ms before that deadline. These are Node callback observations,
not renderer execution or packet arrival times. Other failures, including that
run's Windows screenshot fallback, have no established common cause.

This is an explicit lifecycle-policy change, not a missing-parameter correction
or a claim to fix Chromium latency. The existing 10-second attachment deadline
previously governed Page/Runtime domain setup; the first exact trusted
`browserInspectScript` main evaluation can now consume its unused remainder.
It is not a new ten-second timeout per command or per inspection.

## Contract

- Each new attachment epoch records one monotonic absolute initialization
  deadline. Cached or concurrent attachment calls do not reset it.
- After obtaining the actual document fence, only the first exact trusted
  inspection expression may synchronously claim the remaining window. The
  claim is consumed before expected-identity checks, abort checks and socket
  dispatch. Failure does not refund it. No claim is made by arbitrary page
  evaluation, actions, input snapshots or confirmations.
- When the original remainder is greater than 2000 ms, the existing request
  timer is armed against that absolute deadline. Synchronous dispatch work
  consumes the same time. Expiry before dispatch fails without sending. If the
  reply/continuation is observed only after the deadline, the result remains
  unknown even when the event loop has not yet delivered its overdue timer.
- When the remainder is 2000 ms or less, including an already expired window,
  inspection keeps its ordinary two-second budget. This avoids making a first
  inspection after a user's idle interval fail immediately. The claim is still
  consumed; it cannot be renewed by another inspection or navigation.
- The allowance is tied to the exact epoch/owner/document fence. An invalidated
  fence cannot lend it to a replacement document or successor attachment.
  The initial navigation before the first inspection is supported. A genuinely
  new attachment creates its own deadline through the existing explicit attach
  path; there is no new reconnect or retry path.
- Frame/world reads, action/navigation/input commands, input evidence and
  post-confirmation reads, screenshots, owned-object cleanup and detach retain
  their existing budgets. Document and per-input owner guards are unchanged.
- Existing unknown settlement and cleanup rules remain authoritative. A late
  original reply can settle cleanup, but cannot restore the failed operation.
  No request is replayed and no extra timer or RPC is introduced.

The reviewed #403 live-style reuse and #411 passive observer are inherited from
#419. Their historical failed CI remains recorded. The observer is still
fixture-injected and absent by default; no product UI change is introduced.

## Local evidence

The new deterministic suite executes the actual private client, attachment
setup, document fences, `evaluateDocument`, and transport with a synthetic
socket and monotonic clock. It verifies a 4500 ms remaining window after
5500 ms of setup/frame/world work, a single 3728 ms original reply, concurrent
one-time claiming, delayed first inspection, abort/identity/epoch changes,
original late-reply settlement, overdue timer ordering, unchanged action/input
budgets and no replay. It does not measure native browser performance.

Ordinary exact-head native CI must still pass all gates. A green run establishes
functional acceptance of this bounded policy; it does not establish universal
resolution of intermittent browser startup or screenshot failures.

At the initial local freeze, the new deterministic suite passed 19/19. The three core
policy assertions fail against the exact prerequisite source: the first timer
is 2000 rather than 4500 ms, concurrent first calls both get 2000 ms, and an
original response observed after the absolute deadline can still succeed.
The combined provider, targeted-input, guard, readiness, style and observer
suites passed 626 tests with one Mac-only skip. Full Node TypeScript passed.
Web TypeScript was interrupted by host resource exhaustion and is not claimed
as verified by that attempt; the coordinated verification window and exact CI
remain required.

The R1 review identified a late matching protocol-error reply bypassing the
absolute-deadline classification. The follow-up classifies this reply at receipt,
only for an already dispatched request with the absolute allowance. It settles
cleanup with that same original reply and leaves the operation unknown, without
waiting for another response. On-time protocol rejection (even with a delayed
continuation), unsent failure and ordinary evaluation retain their classifications.
The two exact-boundary/late-error counterexamples fail on the R1 production
source; the other three added controls pass there. After the correction, all
24 initialization-window tests plus 33 original diagnostic-transport tests pass
serially (57 total). Full suites/typechecks have not been rerun for this follow-up
while the coordinated local resource window is reserved for UI verification.
