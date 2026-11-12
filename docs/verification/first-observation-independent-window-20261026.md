# Separate attachment preparation and first trusted observation windows

## Evidence and design decision

The earlier [first-inspection policy](first-inspect-initialization-window-20261015.md)
and [PR #422](https://github.com/albert-zen/zen/pull/422) allowed one exact trusted
inspection to borrow the unused part of its attachment's original 10-second
setup deadline. That was an explicit waiting-policy change, not a measured
end-to-end inspection SLO or a fix for Chromium latency. Later changes shared
the borrowed deadline between isolated-world creation and the main evaluation.

The original failed observations remain failures:

- [Main job 121587957313](https://github.com/albert-zen/zen/actions/runs/40327517457/job/121587957313):
  Runtime setup took approximately 6.18 seconds. The first main evaluation had
  1378 ms remaining and its original reply was observed 223 ms after timeout.
- [Combination job 121593835225](https://github.com/albert-zen/zen/actions/runs/40329015433/job/121593835225):
  Runtime setup took 5776.7545 ms. The first main evaluation had 2013.106 ms
  remaining; its original reply was observed after 2308.646209 ms. Cleanup
  completed with no observer/artifact errors. The provider and fixture source
  matched accepted main.

These are Node callback observations, not wire or renderer execution timings.
Both failures correctly enforced the old contract. The underlying browser
latency remains unexplained. A separate Windows screenshot/socket-close failure
is not attributed to the same cause.

Separate later failures also remain outside this policy change:

- [Windows job 121601611175](https://github.com/albert-zen/zen/actions/runs/40331446433/job/121601611175)
  closed two sockets with code 1006 approximately 721 ms after screenshot
  request 3139 during `input-contracts:shadow:actions`. The process snapshot's
  null exit/signal fields are not proof that Chrome did not exit; the cause is
  unknown, as in the earlier independent Windows disconnect observation.
- [Mac job 121601611497](https://github.com/albert-zen/zen/actions/runs/40331446433/job/121601611497)
  observed an original `Input.dispatchKeyEvent` response after approximately
  3234 ms during `chrome-foreground:cdp-data-isolation`, beyond the ordinary
  two-second mutation deadline. That unknown remains a valid fail-closed result.
  This change does not increase that deadline or authorize replay.

The new product policy gives preparation and first trusted document observation
separate fixed budgets. Successful but slow preparation no longer consumes the
first observation's allowance. Ten seconds is an explicit bounded waiting
choice using the existing startup allowance, not a statistical reliability
guarantee inferred from these two samples. Initial combined waiting can increase
because preparation and observation no longer compete for the same window.

## Exact scope

- Attachment setup keeps its existing 10-second absolute deadline and readiness
  barrier. Expired or failed setup cannot grant an observation window.
- Only the first exact trusted `browserInspectScript` reserves the independent
  10-second observation window after successful setup, synchronously before
  asynchronous document preflight. The reservation belongs to the exact
  attachment epoch, owner and live target. Concurrent/cached callers cannot
  claim it twice. Idle time before the first claim is not preparation time.
- Isolated-world creation and the main evaluation use that same original
  absolute deadline; frame/world/preflight work consumes its remaining time.
  Neither the world response nor evaluation dispatch starts a fresh allowance.
- The existing known pre-world lifecycle rejection can return only the original
  reservation. Its remaining time may be less than two seconds or already
  expired; reclaim never renews it or substitutes an ordinary two-second budget.
  Dispatch, abort, unknown outcome, ownership/epoch change and other failures
  consume it under the unchanged rules. Navigation never renews it.
- Later explicit inspections retain ordinary budgets. A genuinely new explicit
  attachment owns a new epoch; this change adds no detach/reconnect/retry path.
- Arbitrary evaluation, actions, navigation, Input, frame commands, barriers,
  confirmations, nested probes, screenshots and cleanup retain existing
  deadlines. The allowance does **not** make the complete inspection, or the
  combined setup/inspection tool call, a strict 10- or 20-second wall-time task.
- A dispatched world/evaluation timeout remains unknown. Its original late
  reply cannot restore success or publish an observation; existing settlement,
  ownership leases, taints and publication fences remain authoritative.
  Observation code maintains isolated-world registries/observers, so this is
  not a general declaration that arbitrary timed-out evaluation is retry-safe.

The fixture, readiness checks, scenario assertions, CI configuration and ordinary
mutation deadlines are unchanged. There is no warmup, automatic replay or retry.

## Deterministic verification

The existing suite executes the actual client, attachment setup, document fence,
evaluation and transport with only the clock/socket replaced. Updated policy
assertions fail against the unchanged prerequisite production source, then pass
with the independent-window implementation. In the slow-setup counterexample,
setup consumes 7800 ms and frame/world preflight consumes another 1200 ms: the
old shared deadline leaves only 1000 ms, whereas the independent reservation
allows the single original 2300 ms evaluation reply. No command is replayed.

Coverage retains setup expiry before readiness; one-time concurrent claiming;
idle/cached attachments; sub-two-second and expired reservation reclaim;
navigation, owner and retired-epoch rejection; preflight exhaustion; abort;
world/evaluation late success and protocol error; exact response routing;
original settlement; and unchanged ordinary action/Input deadlines.

These synthetic tests establish policy boundaries, not native-browser latency.
The policy suite recorded 65 passes and 11 expected policy-assertion failures
against the unchanged prerequisite implementation, before diagnostic error-label
updates; it then passed 76/76 with the new policy. The full selected provider,
attachment, initialization, targeted-input, observer, readiness and style suites
passed 654 tests with one Mac-only skip. Node TypeScript passed after the standard
local SDK build; the initial fresh-clone attempt lacked generated SDK output and
is not counted as a pass. Formatting and whitespace checks passed. Independent
review found no code/safety blocker, and the root review separately passed all
76 policy tests. Local aggregate verification and native CI are reported
separately; these focused results are not a claim that the full aggregate passed.

Independent review is required before draft publication; exact-candidate native
acceptance is required before merge. No prior red result is reclassified and no
native pass is claimed by this note.
