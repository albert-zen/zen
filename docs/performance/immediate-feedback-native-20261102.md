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

A separate [explicitly instrumented owned Host diagnostic](https://github.com/albert-zen/zen/actions/runs/41392944620) completed successfully to examine actual storage/recovery work during one 5000-turn native send. It preserves the real durable path but is not benchmark timing: only the exact declared child-source instrumentation is allowed, its source and built Host are hashed, nested phase counters remain nonadditive, and the private inspector opens no TCP port.

### Actual owned Host: CPU and recovery work is material

[Instrumented Host run 41392944620](https://github.com/albert-zen/zen/actions/runs/41392944620), exact base `b8c77b80` with only declared diagnostic child-source instrumentation, completed one real 5000-turn send and passed independent persisted identity, complete Trace, and zero-compaction checks.

The child profile window was 23625.3 ms. Process CPU usage was 14536.3 ms user + 1289.5 ms system; event-loop utilization 99.45%, maximum sampled event-loop delay 7298.1 ms. Unlike the renderer profiles, this Host CPU profile had aligned, finite, nonnegative deltas (3118 samples), so weighted stack attribution is valid. Its largest self-sample weights were two `contextForFacts` stacks totaling 13302.0 ms and two `normalizeTimeZone` stacks totaling 2750.1 ms. These are sampling-weighted elapsed attribution, not separate OS CPU-accounting counters or proof of a proposed fix.

| Actual phase | Calls completed | Aggregated elapsed wall time |
|---|---:|---:|
| Domain assertRecoverySafe | 1 | 2134.4 ms |
| Domain public reconcileCompilation | 1 | 1376.0 ms |
| Trace read | 8 | 2211.6 ms |
| Semantic exists | 13 | 7437.5 ms |
| Semantic read | 5 | 2160.7 ms |
| Domain append | 2 | 14043.3 ms |
| Semantic append | 1 | 816.0 ms |

All listed counters had zero errors/in-flight calls at stop, with no dropped phase spans. **Do not sum nested phase wall times.** One semantic-exists span lasted 6854.5 ms, but an awaited operation can be delayed by unrelated synchronous work on the same event loop; this is not evidence of 6.85 seconds of disk I/O. Other concurrent Host operations may contribute during the measured window. The main IPC duration also includes profiler start/stop/result-transfer overhead and is excluded from baseline comparisons.

The strong source-level investigation priorities from this run are repeated `contextForFacts` work and timezone normalization, not an unmeasured claim that fsync alone caused the slowdown. Renderer feedback latency and durable-admission latency remain separate unresolved acceptance requirements.

## Narrow empty-autosize experiment: not a 5000-turn fix

Exact source `12c13b536b532c6690fdf6a26b1d32d95273834d`, [unchanged native acceptance run 41393576560](https://github.com/albert-zen/zen/actions/runs/41393576560):

| Prior turns | Pending DOM, ms | First visible / input clear, ms | Canonical bubble visible, ms | Strict outcome |
|---|---|---|---|---|
| 0 | 17.5 / 28.8 / 12.1 | 21.2 / 29.7 / 13.4 | 673.6 / 190.1 / 142.1 | PASS |
| 1000 | 89.5 / 62.9 / 97.2 | 126.9 / 72.4 / 135.7 | 2947.8 / 4388.8 / 3514.0 | PASS this three-sample run |
| 5000 | 613.4 / 357.1 / 276.8 | 767.1 / 386.0 / 324.9 | 28747.0 / 21996.9 / 25809.7 | **FAIL all three** |

All nine sends passed exact identity, independent storage reopen, complete Trace and zero-compaction checks. Independent hosted runners and three samples per size do not establish a stable tail-latency guarantee or causal improvement. The 5000-turn failure is retained.

The initial check run had 134/136 tests pass with typecheck/build successful: one existing test required inline height `36px` while the experiment intentionally delegates empty height to CSS `auto`; another existing ResizeObserver stub supplied no entries and failed `entries.find`. These are not presented as a passing check run. Test/format successor `284d1c8` keeps the measured product behavior and corrects the fixtures; new checks are separate. Real narrow/localized-placeholder and multiline-to-empty geometry acceptance remains outstanding; jsdom call counts are not visual proof.

A narrowly combined source `5e37358e69fd7344aac25cfd3802078b92f79e2d` overlays exactly the two PR614 context-prefix files onto that same UI candidate. Its intermediate native run is **5000 turns only**, not an unnecessary full variant matrix. Later release acceptance must still use the complete required history sizes and strict feedback/durable metrics separately.


## Context-prefix candidate: intermediate 5000-turn acceptance remains failed

Exact combined source `5e37358e69fd7344aac25cfd3802078b92f79e2d`, [run 41394449321](https://github.com/albert-zen/zen/actions/runs/41394449321), three ordinary sends with 5000 prior completed turns:

| Metric | Sample 1 | Sample 2 | Sample 3 |
|---|---:|---:|---:|
| Pending DOM, ms | 1143.3 | 335.5 | 653.5 |
| First visible feedback / input clear, ms | 1376.0 | 383.4 | 775.2 |
| Canonical bubble visible, ms | 20975.6 | 16566.5 | 22392.5 |
| Actual main IPC duration, ms | 11452.957 | 6813.930 | 9002.989 |

All three sends passed independent persisted identity, complete Trace and zero-compaction checks, but **all three fail the unchanged 200 ms feedback/clear requirement**. Compared with the earlier autosize run, these independent-runner, three-sample measurements suggest a durable-admission direction worth investigating; they do not establish a causal or tail-latency guarantee and do not resolve the user-visible problem.

[Check run 41394449192](https://github.com/albert-zen/zen/actions/runs/41394449192) passed six context-preparation tests, 246 UI tests, typecheck and build. Separate strict [context-prefix proof 41394610388](https://github.com/albert-zen/zen/actions/runs/41394610388) accepted baseline RED only for exact slice-count assertions 65/257/1025 versus zero, while all three semantic oracles passed; candidate passed all six. Separate [timezone-normalization proof 41394947273](https://github.com/albert-zen/zen/actions/runs/41394947273) accepted baseline RED only for constructor counts 1000 versus 1 and 258 versus 257, with three semantic tests passing; candidate passed all five. These narrow operation-count proofs are not native performance acceptance.

## Actual full-App geometry: initial partial pass and fixture failure retained

[Initial geometry run 41395198231](https://github.com/albert-zen/zen/actions/runs/41395198231) exercised both English and Chinese in independent private full-App instances. All six geometry assertions passed in each locale: actual textarea width 822 px at window width 1280, then 319.203125 px at legal window width 1120 after opening the production Subagents pane and dragging the actual splitter. A 400-character native draft wrapped from height 90 to the CSS maximum 136 px (scroll height 216); clearing returned to the measured CSS minimum 36 px. Twenty native text lines reached max height 136 with scroll height 426; clearing restored height/scroll height 36 and overflow hidden.

The real placeholders fit the narrow field (English approximate text width 131.5 px, Chinese 98.1 px, content width approximately 303 px). **Localized placeholder wrapping was not triggered and is N/A**, not an invented passing wrap test. Two full-page narrow-empty screenshots were independently viewed through [artifact-only readback 41396230815](https://github.com/albert-zen/zen/actions/runs/41396230815): whole App, real navigation and open right pane are visible, and neither locale's empty composer/placeholder is clipped.

The overall initial geometry job **failed** because its final reset tried the closed-pane toggle, which is not available while the pane is open. Consequently, its final real send and storage verification were not reached. The selector-only repeat uses the production `.auxiliary-close-button` with actual native input; no product state, geometry or performance gate was changed. Its result is recorded separately rather than rewriting the original failure.


The selector-only [repeat 41396096033](https://github.com/albert-zen/zen/actions/runs/41396096033) **passed both locales end to end**. All six geometry cases passed again; each locale then closed the real pane, sent one ordinary message through actual native input/Send, matched its real receipt and canonical identity, and independently reopened production storage after Host shutdown: exactly one new message, complete Trace, zero compaction facts or attempts. This closes the tested geometry/regression loop only, not the failed 5000-turn latency acceptance. The earlier failed run remains above.


## Current-main combined candidate 617: native feedback gate passes in this run

Exact product `2bfd08e0d72fbe634b73bbfe86739296e23342b3`, parent `8ec519f2da880d0c1184665fde07231262013b08`. This is a new current-main combined acceptance source preserving unrelated main changes, not a causal comparison for one optimization. It includes the reviewed frontend feedback/autosize changes plus bounded Domain reconciliation, Trace durability, context-prefix and timezone-normalization changes; no append-log experiment or steer-recall feature is included.

[Native run 41396686595](https://github.com/albert-zen/zen/actions/runs/41396686595) passed the unchanged **both visible feedback and input-clear <=200 ms** requirement for all nine warm ordinary sends:

| Prior completed turns | First visible feedback / input clear, ms | Canonical bubble visible, ms | Actual main IPC duration, ms |
|---|---|---|---|
| 0 | 26.0 / 28.4 / 12.5 | 331.1 / 211.1 / 218.2 | 275.6 / 173.8 / 180.9 |
| 1000 | 41.1 / 66.2 / 45.1 | 2026.1 / 2509.3 / 2299.1 | 901.8 / 695.6 / 924.2 |
| 5000 | 132.8 / 96.3 / 157.3 | 3305.0 / 3010.2 / 3877.0 | 1425.3 / 1239.9 / 1285.2 |

For 5000 turns, pending DOM appeared at 95.9 / 73.5 / 135.0 ms. All historical 5000 Turn blocks, 5000 user rows and 5000 assistant rows were actually rendered. All nine messages passed actual receipt/canonical identity matching, final projection verification, independent production-storage reopen, unique persistence, complete Trace and zero compaction facts/attempts.

These are **three samples per history size on disposable hosted Mac runners**, not a p95 estimate or a guarantee on the user's device. Visible feedback is the actual product's honest local pending state, not durable admission or model consumption. Canonical rendering at 5000 turns still takes 3.0–3.9 seconds and actual IPC 1.2–1.4 seconds in this run; those separate costs remain visible and are not hidden by the fast pending row.

The exact same candidate also passed [all four native controlled-fault cases 41396686660](https://github.com/albert-zen/zen/actions/runs/41396686660), with four unique persisted messages and complete zero-compaction Trace, and [full-App English/Chinese geometry 41396686761](https://github.com/albert-zen/zen/actions/runs/41396686761), including all six geometry checks per locale plus actual send and independent storage reopen. Controlled-fault and geometry sends are correctness checks, **not additional performance samples**. Normal repository CI/review/release approval remains separate.
