# Ordinary-send native baseline — 2026-11-02

Status: **ordinary long-thread send latency reproduced**. This document does not claim that the product is fixed or that the candidate changes are merge-ready.

## Method and boundary

- Exact production baseline: `6aa0a5055530eeb018cc41a3ce486603756c06bb`.
- Actual built Electron 43.2.0 App/main/preload/renderer on isolated hosted native macOS; Chromium sandbox and context isolation remain enabled.
- Private HOME, Documents, profile, workspace and production DomainThreadJournal/FileTraceStore/FileItemListStore. No copied credentials, user-device interaction, real provider calls or fake send ACK.
- Seed one completed turn per synthetic user/assistant pair, 256 characters per message. Validate production Host projection before measuring.
- Real Electron native pointer input and text insertion. Measure a trusted renderer click, canonical user bubble DOM insertion and visible requestAnimationFrame opportunity, and composer clearing.
- Main-process IPC request-to-real-receipt duration uses its own clock. **No cross-process clock subtraction.**
- Existing selected idle Thread, warmed by initial production read; not cold startup/new-draft send.
- Every successful job verifies three unique client/message IDs through actual protocol receipts/events and independently reopened read-only canonical storage after normal Host shutdown.
- Zero persisted compaction facts and zero production Trace compaction started/sample/finished records. The fixture's manual 100,000,000-token fake-model window isolates ordinary sends; it is **not a product configuration recommendation**.
- Frame observations are not physical scanout guarantees. Whole-window synthetic before/after screenshots are included in each artifact.
- Three samples per case, on separate hosted runners. These are diagnostic observations, not a statistically established percentile or hardware-normalized benchmark.

## Baseline results

All times below are milliseconds, in sample order.

| Prior completed turns | Actual DOM messages | Click → visible bubble frame | Click → composer clear frame | Main IPC duration |
|---|---:|---|---|---|
| 0 | 0 | 300.1 / 119.3 / 137.6 | 300.1 / 119.3 / 137.6 | 228.7 / 104.2 / 101.6 |
| 1,000 | 2,000 | 2289.4 / 3507.2 / 2313.5 | 1638.0 / 2349.6 / 1663.2 | 823.7 / 1078.2 / 963.9 |
| 5,000 | 10,000 | 29546.5 / 27919.4 / 24568.4 | 29546.5 / 17564.2 / 15507.6 | 8110.0 / 4783.1 / 4057.7 |

The 5,000-turn case has 20,001 canonical facts, 10,000 semantic items and a 9,978,896-byte ItemList. Its total run took several minutes; that total is **not** the per-message send latency. Other Host configuration requests hit their 5-second deadline during that case; causality has not been isolated.

Evidence:
- [0 / 1,000 baseline run](https://github.com/albert-zen/zen/actions/runs/41382515074), jobs `125076177156`, `125076177366`.
- [5,000 baseline run](https://github.com/albert-zen/zen/actions/runs/41383484055), job `125079125567`.
- [5,000 full-window screenshots and JSON](https://github.com/albert-zen/zen/actions/runs/41383484055/artifacts/13115055346).

## Isolated candidate observations: 1,000 turns

| Product source | Click → visible bubble frame | Main IPC duration |
|---|---|---|
| Repeated untouched baseline `6aa0a505` | 3176.4 / 2676.8 / 2890.1 | 1344.3 / 1115.0 / 1151.1 |
| Backend only `8e036167d864ae5d452dccc411970352ce26e433` | 1703.8 / 1568.4 / 1571.5 | 727.2 / 578.4 / 567.7 |
| Frontend only `3819977ddd2da5698bcbee2c14fd8165f9934009` | 1136.2 / 1251.9 / 1203.2 | 632.8 / 579.6 / 617.9 |

- [Repeated baseline/backend run](https://github.com/albert-zen/zen/actions/runs/41383780603), successful jobs `125080038999`, `125080038844`.
- [Frontend successful repeat](https://github.com/albert-zen/zen/actions/runs/41384321599), job `125081682828`.

Each row passed the durable message and no-compaction checks. Separate-runner results demonstrate improvement candidates but do not establish an exact causal percentage. Even the improved observations remain around 1.2–1.7 seconds; **not an acceptable final fix**. Combined-source and further optimization acceptance remain open.

## Invalid / incomplete attempts retained

- First fixture used an invalid null reasoning effort and failed to configure its private workspace. Those jobs failed before valid send samples; no latency conclusion is drawn from them.
- The first 5,000-turn execution exhausted a 240-second owned-process budget without a complete sample report. It is not reported as a 240-second send.
- Initial frontend A/B attempt failed to commit native text before Send, with zero send IPC requests. The successful repeat waits for actual native textarea focus before insertion; no JavaScript focus/value assignment or forced click was introduced.


## Combined candidate: negative end-to-end result retained

The combined production candidate `a8c7615b11b3a8f63c4d251a6fe5da5b82e13f09` passed native message integrity/no-compaction checks, but did **not** demonstrate acceptable send latency:

| Prior completed turns | Click → visible bubble frame (ms) | Main IPC duration (ms) |
|---|---|---|
| 1,000 | 3417.7 / 2136.3 / 3810.4 | 1839.0 / 1087.6 / 1377.6 |
| 5,000 | 30311.7 / 46670.4 / 22686.1 | 14753.3 / 16490.6 / 14166.6 |

[Combined native run](https://github.com/albert-zen/zen/actions/runs/41385416571), jobs `125085055892` and `125085056053`. The 5,000-turn run again observed other Host configuration request deadlines. These samples cannot be attributed to runner variability, residual work or a combination regression without further evidence. A same-runner interleaved A/B/A/B comparison is the next diagnostic gate, not an assumption that the combined change is faster.

The first combined component regression proof failed its final collapsed-details UI text assertion, not its scan budget. That test setup is being corrected separately; it does not invalidate or explain away the above native latency observations.


## Same-runner interleaved comparison

[ABAB run](https://github.com/albert-zen/zen/actions/runs/41386855210), job `125089490997`, completed successfully. Baseline and combined artifacts were each built once on the same hosted Mac. Each block used a new private profile, the same 1,000 completed turns / 2,000 actual DOM messages, and three real sends.

| Block | Source | Click → visible bubble frame (ms) |
|---|---|---|
| A1 | Baseline `6aa0a505` | 3212.4 / 5899.3 / 4602.2 |
| B1 | Combined `a8c7615b` | 5231.0 / 5113.6 / 5816.2 |
| A2 | Baseline `6aa0a505` | 6008.8 / 6445.2 / 3717.3 |
| B2 | Combined `a8c7615b` | 3565.1 / 3236.9 / 3251.1 |

All twelve messages passed receipt/canonical/independently reopened storage checks; compaction attempts and facts remained zero. Block medians worsen from A1 to B1 and improve from A2 to B2. Pooled descriptive medians (six samples per source) are 5250.8 ms baseline and 4339.4 ms combined; this does **not** establish a stable statistically significant improvement or an acceptable end-user outcome.

The runner reported three virtual M1 CPUs and one-minute load averages between roughly 12.5 and 22.0. These observations do not by themselves assign causality. The App renderer's reported working set rose from roughly 0.55 GiB before each block to 1.7–2.6 GiB afterward. This is a profiling lead, **not a demonstrated memory leak**.

### Measurement overhead audit

Per sample, the passive bubble observer inspected one row candidate and four or five added elements. Accumulated mutation callback time was 0.1–2.7 ms; measured frame-callback work was 0.3–4.0 ms. Thus the directly measured callbacks do not account for multi-second delays in this run. The observer does not scan the entire document text or serialize history during the timed interval; IPC instrumentation clones only the small real receipt.

These counters do not prove zero total harness disturbance. Initial and post-sample real history reads and screenshots occur outside the timed interval, but could affect caches or garbage collection. Future harness revisions should retain every message-integrity assertion while minimizing redundant full-history transfers, and identify that measurement change explicitly. There is no hidden reduction of fixture history or UI row count.

## Narrow regression proof

[Strict operation-count proof](https://github.com/albert-zen/zen/actions/runs/41386855158) completed successfully:

- Untouched baseline plus identical regression tests failed only the intended assertions: backend context iteration counts 4,160 / 65,792 and frontend 56,000 canonical type reads. Missing-suffix and frozen-history semantic tests passed.
- Corrected-test combined snapshot `cb3b4300bd082bd5fbb7053d2977b5c5c6fee220` passed all seven required tests: four backend, one real component budget/disclosure assertion, and two outcome-index semantics/count tests.
- The correction opens the existing details disclosure before asserting its unique diagnostic ID. It does not change product code, history size, budgets or gates.

This proves the narrow algorithmic regressions and semantic guards, not that overall message sending is fast. Immediate pending-feedback architecture, durable-confirmation throughput and further full-App acceptance remain open.
