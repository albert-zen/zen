# Immediate feedback native acceptance — 2026-11-02

This report does not declare the send-latency issue fixed. Candidate `a36e76de2c75a297aae6a1ecc09faefc1dfe2433` separates honest renderer-local sending feedback from canonical admission.

## Contract and method

Same complete production Electron App and production DomainThreadJournal/Trace/ItemList synthetic-history seed as the [ordinary-send baseline](ordinary-send-baseline-20261102.md). Actual native text input and Send click; fake provider only, isolated private profile, no compression, no UI/ACK fabrication. All rows rendered (1000 prior turns = 2000 user/assistant messages). Version `native-feedback-v2-single-final-history-read` performs one initial full history verification, **none between timed samples**, and one final full read; the normal Host shutdown is followed by independent read-only storage verification.

First visible feedback is the earlier of matching local pending and matching canonical bubble visibility at a requestAnimationFrame opportunity, **not physical screen-scanout proof**. Absent pending is null, never zero. Canonical/IPC times remain distinct. Each of all three candidate samples must have first-visible feedback and input clear at or below **200 ms**. All samples and durable integrity verification finish before this strict performance assertion; the target is not relaxed on failure. Three samples are not a p95 estimate.

## Completed candidate results

[Run 41389445746](https://github.com/albert-zen/zen/actions/runs/41389445746). Separate hosted Mac runners; no same-machine causal effect claim.

| Source / prior completed turns | First visible feedback, ms | Input clear, ms | Canonical bubble visible, ms | Result |
|---|---|---|---|---|
| Pending candidate / 0 | 33.1 / 10.0 / 15.5 | 33.1 / 10.0 / 15.5 | 289.9 / 160.9 / 164.1 | PASS |
| Pending candidate / 5000 | 2391.4 / 2335.3 / 1821.0 | 2391.4 / 2335.3 / 1821.0 | 33389.5 / 21404.8 / 35183.5 | **FAIL every sample: over 200 ms** |
| Pending candidate / 1000 | 851.2 / 253.5 / 311.2 | 851.2 / 253.5 / 311.2 | 4822.6 / 2819.3 / 3931.1 | **FAIL every sample: over 200 ms** |
| Unchanged baseline `6aa0a505` / 1000 | 5855.9 / 8309.2 / 5683.3 (canonical; pending absent) | 4008.4 / 5830.0 / 4579.5 | 5855.9 / 8309.2 / 5683.3 | Integrity PASS; control not subject to new UI acceptance |

Pending candidate 1000-turn first pending DOM appeared after 828.0 / 240.2 / 295.5 ms; main-process actual IPC durations were 2294.2 / 1534.0 / 1913.1 ms. These metrics do not by themselves establish which synchronous work caused the delay. Hosted load was high and is recorded, not an excuse to change the threshold.

Every reported sample above passed canonical client-ID/message-ID matching, exactly one persisted new user message, independent read-only reopen, complete Trace, and zero persisted compaction/compaction-attempt checks. The 1000-turn job failed **only after** publishing verified numeric results because the timing requirement was missed.

The 5000-turn candidate rendered all 10000 historical user/assistant rows. First pending DOM: 2255.0 / 2184.9 / 1698.6 ms; actual main IPC: 14513.2 / 6643.9 / 15443.8 ms. All three new messages passed the same independent persistence and zero-compaction checks, then the strict timing assertion failed. Long-history acceptance is **not met**.

## Controlled faults are not performance samples

Separate named suite gates real handler dispatch or forwarding of real notifications/replies, never invents an admission. Assertions cover blocked admission local feedback, canonical-before-ACK, ACK-before-canonical, generic lost-reply unknown state, no automatic resend, and preservation/explicit restoration of a newer draft.

Initial [fault run 41389737321](https://github.com/albert-zen/zen/actions/runs/41389737321) verified the first blocked-admission and newer-draft-preservation case but failed the **fixture reset**: synthetic Mac Meta+A did not select all, so Backspace removed only the last character. Other cases did not execute. It is not an overall pass or a product fault. The narrowly repaired fixture uses Electron native selectAll, verifies actual textarea focus/selection range, then native Backspace. No JavaScript DOM value assignment. Fault-only repeat [41390456335](https://github.com/albert-zen/zen/actions/runs/41390456335) **passed all four named cases**: blocked true admission, canonical before held ACK, true ACK before ordered canonical delivery, and generic lost reply after true admission. It verified no auto resend, explicit native restore appending to a newer draft, no late clearing/duplication, and four unique canonical messages after independent storage reopen. The lost-reply real handler result remains separate from the deliberately undelivered renderer reply. Fault timings are excluded from performance results.

## Stable-context follow-up remains below acceptance

Exact follow-up production source `b8c77b80fa547fddfa7875e11a932d37b143e473`, unchanged v2 native driver. [Native run 41390735989](https://github.com/albert-zen/zen/actions/runs/41390735989); [134/134 targeted tests, typecheck and production build passed](https://github.com/albert-zen/zen/actions/runs/41390736199). These are independent hosted samples, not a same-machine statistically established speedup.

| Prior turns | Pending DOM, ms | First visible pending / clear, ms | Canonical bubble visible, ms | Strict outcome |
|---|---|---|---|---|
| 0 | 107.4 / 12.7 / 17.0 | 123.5 / 14.2 / 17.8 | 1439.4 / 311.3 / 202.5 | PASS |
| 1000 | 99.7 / 72.0 / 230.1 | 125.6 / 100.6 / 261.2 | 2875.2 / 2514.6 / 2773.6 | **FAIL: third sample over 200 ms** |
| 5000 | 227.4 / 254.5 / 827.1 | 309.9 / 287.2 / 888.1 | 20469.9 / 17425.6 / 21475.2 | **FAIL: all three over 200 ms** |

Canonical notification after native click (same renderer clock) at 1000 turns: 2024.3 / 1619.6 / 1893.4 ms; at 5000: 17533.3 / 13513.0 / 15318.1 ms. Main actual IPC duration at 1000: 1903.6 / 1545.0 / 1644.2 ms; at 5000: 17294.9 / 12218.9 / 14442.4 ms. Renderer and main-process clocks are never subtracted from one another.

All nine candidate sends passed independent persistence, exact identity, complete Trace and zero-compaction checks. The performance failures are deliberately retained. Pending DOM-to-visible gaps were 25.9 / 28.6 / 31.1 ms at 1000 turns and 82.5 / 32.7 / 61.0 ms at 5000; most residual delay in these samples precedes insertion of the pending DOM, but these timestamps alone do not identify a specific React or layout operation.

A separately labeled, **profiling-perturbed, non-acceptance** [owned renderer profile run](https://github.com/albert-zen/zen/actions/runs/41391701278) completed successfully. It uses the same exact source, one real native send per history size, bounded Long Animation Frame / long-task entries plus in-process Electron debugger CPU and timeline recording. It does not attach to a user app, open a debugging port, substitute a React profiling build, or reuse its timings as benchmark samples.

### What the renderer profile establishes — and does not

One profiled send per history size did **not reproduce the worst unprofiled tail**. Same-renderer native click to handler activation was 1.0 ms (1000 turns) / 0.8 ms (5000); handler activation to pending DOM was 48.6 / 108.8 ms. This is not an acceptance rerun and does not erase previous failures.

Trace user-timing marks were present, ordered, same process/thread, with no capped events. Within native click to pending DOM, event-name union durations were:

| Prior turns | Entire pre-DOM interval | UpdateLayoutTree | Layout |
|---|---:|---:|---:|
| 1000 | 49.528 ms | 18.306 ms | 6.283 ms |
| 5000 | 109.554 ms | 40.213 ms | 23.443 ms |

Nested categories overlap; do not sum these with JavaScript event durations. At 5000 turns the first style recalculation visited 5061 elements (39.673 ms) and the first document layout reported 205415 total layout objects (17.976 ms), versus 1061 / 41415 at 1000 turns. This supports real synchronous style/layout work before local feedback, not a particular caller stack.

[Artifact-only validation](https://github.com/albert-zen/zen/actions/runs/41392469861) found negative V8 sample deltas in **both** CPU profiles: 5 at 1000 turns (minimum -2487 microseconds), 6 at 5000 (minimum -8038). Consequently, weighted CPU rankings and percentages are **invalid and are not evidence**. Raw profiles are retained; no negative samples were silently discarded. Long Animation Frame entries were supported but had no script attribution.

The exact rebuilt renderer SHA256 matched both recorded artifact hashes before mapping source offsets. Relevant sampled source locations include `useReadVisibleMessage` scanning all `[data-read-message-id]` nodes, `followBottom` reading/writing scroll geometry, and `ComposerEditor` writing auto height then reading scrollHeight/computed style. These are source-backed investigation leads, **not proof that any one caused the slow tail**.

A separate [explicitly instrumented owned Host diagnostic](https://github.com/albert-zen/zen/actions/runs/41392944620) is now running to distinguish actual storage/recovery work during one 5000-turn native send. It preserves the real durable path but is not benchmark timing: only the exact declared child-source instrumentation is allowed, its source and built Host are hashed, nested phase counters remain nonadditive, and the private inspector opens no TCP port.
