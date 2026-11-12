# Follow-up audit of the original 18 failures

The original full local run remains 5,117 tests / 5,077 passed / 18 failed / 22 skipped. The 18 were full-suite failures, not eighteen quote defects. Follow-up compares unchanged main `6aa0a505` with the quote branch using the same local Node environment and the exact eighteen failing test names (two test workers).

## One missed fixture update, now fixed

`self-control-usability.test.ts` contained a simulated model that parsed only the previous `Original conversation history; sN;` wrapper. The concise reader/ref header made that assertion fail before the simulated model could call the reader. Commit `94dda3af` updates that exact matcher; it does not relax the real tool-call, item, pagination, original-output or source-identity checks. The test was reproduced failing, then passed; all 17 tests in the file pass. Independent R3 review found no blocker. There was no corresponding change to production reader code in this fix.

## Eleven failures also reproduced on unchanged main

| Area                                   | Count | Observed failure                                                                  |
| -------------------------------------- | ----: | --------------------------------------------------------------------------------- |
| Source Find and queued-dialog focus    |     2 | Expected keyboard handling/focus was absent; queued focus varies on both branches |
| Fleet shell and external file opening  |     2 | `/var/...` and macOS-resolved `/private/var/...` paths compared as unequal        |
| Rooms, Fleet, and trigger integrations |     5 | Expected turn/delivery/trigger completion absent or timed out                     |
| IM Gateway lifecycle                   |     1 | Fixture Gateway failed to start                                                   |
| macOS Host launch-path observation     |     1 | Synthetic Host shell command exited 128                                           |

The main comparison reproduced ten of these in one run. The remaining queued-dialog test was repeated three times per branch: unchanged main failed twice and passed once; the candidate failed once and passed twice. This confirms existing nondeterminism, without establishing its timing root cause.

## Six original failures did not recur in either targeted comparison

Three login-PATH tests, two project/Git probing-budget tests, and one IM consent-revision test all passed on both branches in the targeted run. Their original full-suite failures remain real observations; concurrency/timing/environment sensitivity is a hypothesis, not an established cause.

The targeted comparison after the fixture correction has no remaining deterministic candidate-only failure. This is not a claim that the full suite is green. Remote CI evaluates its own exact head; older-head successes must not be reported as the new head's result. Local comparison logs and the six repeated focus runs remain with the task artifacts.
