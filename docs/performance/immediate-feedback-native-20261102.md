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
