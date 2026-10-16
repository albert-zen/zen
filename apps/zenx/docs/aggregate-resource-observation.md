# Passive aggregate resource receipts

The existing CI-only execution reporter samples Linux resource totals on eligible
`test:dequeue` receipt, at most once every 15 seconds of monotonic time. It adds no
timer, process, signal handler, retry, test timeout, concurrency flag or wrapper.
There is no sampling while events are absent, no catch-up and no final forced read.
Reads happen after the original dequeue record is written.

Fields are fixed numeric values or null, plus fixed labels and receipt timestamps.
`MemTotal`, `MemAvailable`, `SwapTotal`, `SwapFree` are host-visible **KiB**, not
process RSS. `memory.current` and bounded `memory.max` are **bytes**. A `max` limit
has `limitState: unlimited` and `maxBytes: null`; unknown is never zero.
The only cgroup scope is the visible `/sys/fs/cgroup` root. A readable fixed
`cgroup.controllers` marks v2; missing/unsupported/unavailable gives version null.
There is no v1 or nested-cgroup discovery, and no reading of membership paths,
mount lists, command lines, environments or process lists. Missing, malformed,
overlarge and unreadable fields become null, without error strings or raw input.

These are sequential, non-atomic snapshots. Root limits/counters need not identify
the job's nested cgroup. An `oom_kill` increase is only an event in the observed
scope, not proof that a particular child or runner was killed by OOM. No increment,
an unavailable field or a stale last sample cannot rule out OOM. Sample time is
reporter receipt time, never a buffered case's execution time. Compare the last
sample's UTC with shutdown UTC explicitly.

The original trace keeps its complete 4 MiB combined file/console budget and its
8,192 dequeue cap. Resource receipts have a separate **32 KiB combined** budget,
**32 sample** cap and **1,024-byte** record maximum. Overall output is therefore at
most **4 MiB + 32 KiB**, counting both sinks even if one fails. Before reading, the
resource writer requires room for one maximum-sized dual-sink record, so it may
stop below the byte cap. At either resource cap, or when the original trace stops,
no more resource files are read. The last resource record retains its own UTC and
elapsed time; an absent later record or end marker does not establish completion.
The caps and event gaps mean this is not a promise of continuous or full-job coverage.

Inputs use fixed paths and bounded reads: meminfo 16 KiB, controllers/events 4 KiB,
scalar files 128 bytes, with one extra byte solely to detect overflow. Unknown text,
paths, environment values and read errors are never copied into resource output.
Only existing CI observed checks enable collection; standalone trace unit fixtures
can inject the clock, reader, platform and sinks without reading host resources.

## File completion and reporter memory

The next observation keeps default file concurrency. PR #435's concurrency-two experiment also ended in runner shutdown; its low host-visible available-memory and swap observations support memory pressure but do not prove OOM or identify a test/process.

The opt-in CI reporter pairs eligible file-wrapper `test:complete` with a recorded dequeue: normalized repository test path equals the name, nesting 0, line/column 1, and an unambiguous prior start. Child cases, unknown paths, duplicate completions, and ambiguous duplicate starts cannot close a window. Missing completion means unknown; it does not prove the file is still executing. Node 22.23.3's parent FileTest emits completion independently of its child-event buffer; TAP pass/fail order is not used. Completion timestamps mark the Node parent FileTest lifecycle only. They do not prove all OS descendants exited or memory was released, and are not guarantees of OS exit on cancellation paths. See [Node Test.postRun](https://github.com/nodejs/node/blob/v22.23.3/lib/internal/test_runner/test.js#L1095-L1105) and [FileTest](https://github.com/nodejs/node/blob/v22.23.3/lib/internal/test_runner/runner.js#L168-L259). A tiny fixture on official SHA-256-verified Node 22.23.3 confirmed a fast file wrapper complete at75.85 ms before its buffered child complete at426.52 ms; the earlier slow wrapper completed at426.17 ms. All fixture tests passed. Node24 has different child-event forwarding and is not used as a substitute for this ordering check.

A successful existing host-resource sampling opportunity also permits a fixed numeric `process` record: reporter PID, main-thread flag, process-wide RSS bytes, current-isolate used/total/limit heap bytes, and elapsed milliseconds. RSS includes all threads; isolate heap excludes other workers and child processes. `process.memoryUsage.rss()` and `v8.getHeapStatistics()` are called only after budget checks. Errors/invalid numbers become null; no descendant `/proc` paths, process names, command lines, environments, new timers, processes, or signal handlers are introduced. A Node worker thread ID is not treated as a Linux task ID.

Additional budgets count both sinks even if a sink fails: completion ≤256 KiB, ≤512 records, ≤512 bytes per sink record; process ≤16 KiB, ≤32 records, ≤256 bytes per sink record. Matching state holds at most512 bounded file identities. These budgets do not consume the original4 MiB dequeue budget or32 KiB host-resource budget. Maximum combined output is4 MiB+32 KiB+256 KiB+16 KiB. Sampling ceases at caps; the last record's timestamp remains the last observation, with no guaranteed coverage duration. No completion is synthesized at shutdown. Instrumentation has bounded overhead and cannot change suite exit status; all tests, assertions, default concurrency, process isolation, and20-minute CI timeout remain unchanged.

## Next diagnostic: owned process attribution (#415)

This experiment asks a narrower, falsifiable question: **at the already observed low-host-memory sampling opportunity, does one of the reporter's owned process-leader descendants hold the memory?** #436's reporter RSS was only about 37 MiB at that opportunity. That excludes neither other processes nor unsampled peaks. Runner shutdown is not equated to OOM. A passing later run is not a fix.

The same meminfo read now also projects AnonPages, Shmem, Slab and SUnreclaim in KiB. These help distinguish anonymous userspace growth from shared/kernel memory; they are not disjoint buckets and must not be summed blindly. The existing 15-second event-triggered opportunity, 32 samples and host-resource budget stay unchanged. No timer is added. In particular, the previous 34-second no-event tail is still unobserved. The hypothesis can be answered at a captured low-memory sample, not necessarily at shutdown.

A separate `owned-processes` receipt always declares `incomplete: true` and `scope: leader-descendants`. It emits numeric PID, PPid, start ticks since boot, depth, RSS/Swap KiB and Threads only; missing memory fields are null. No executable names, command lines, environments, user identifiers, thread stacks, cgroup membership paths, global process enumeration or signals are accessed. stat/status necessarily contain mixed metadata in the bytes read; all unselected fields (including comm/name) are discarded. Stat's final closing parenthesis is parsed so embedded parentheses/newlines in comm do not shift identity fields. Only fixed labels and numbers leave this observer.

For each sample a new root directory `/proc/<reporter PID>` is opened with O_DIRECTORY and O_NOFOLLOW; discovered numeric children open `/proc/<child PID>` at most once. Every subsequent file read uses `/proc/self/fd/<held directory FD>/stat`, `/status`, or `/task/<that PID>/children`. This is directory-FD-anchored traversal, not a reopened numeric PID path. The proc directory FDs remain open until sample cleanup, including failures. See [Linux proc lifetime](https://www.kernel.org/doc/html/latest/filesystems/proc.html): operations using an old process's open proc descriptor cannot silently operate on a new process reusing its PID. A process born before initial directory acquisition can be a legitimate current child; there is no cross-sample PID cache claiming it is an earlier process. PID/start ticks are observation identity, not authorization or a globally unique durable ID.

Child stat PID/PPid/starttime is checked before and after status. Status PID/PPid must match. Before accepting a row, each held ancestor's stat identity and children membership is re-read up to the root. Disappearance, reuse, changed PPid, missing membership, malformed identity or read failure reject the candidate. These are sequential observations, **not an atomic snapshot**: processes may change or exit immediately after validation. Previously accepted rows are observations at their validation interval, not a guarantee all rows coexist at sample end. No freeze/pidfd/signal is used.

Coverage is deliberately limited: depth <=2; <=8 candidate children (invalid/duplicate candidates consume slots); process-leader children only, so other-thread-spawned children, reparented descendants, short-lived processes, deeper or over-limit nodes and unrelated runner/host processes can be absent. Threads is a coverage hint, not additional RSS to sum. RSS can count shared pages repeatedly; VmSwap omits shared-memory swap. Never infer the responsible test from the last printed name or wrapper timing alone. Prior #436 completion receipts are retained as timing context, not PID-to-test attribution.

Exact additional per-sample IO ceilings:

- <=9 proc directory opens and <=9 directory closes (root plus8 candidates); descriptor paths are only those described above.
- <=80 bounded file reads; each opens/closes one descriptor and performs at most2 read syscalls (up to limit+1 bytes, then1 EOF-detection byte). stat/status limit4096; children limit1024. Short or overlong input cannot be silently accepted as a complete children listing.
- Before each read, reserve limit+2 bytes. Total reserved input <=128 KiB, including overflow probes; bounds may stop the traversal earlier. <=160 read syscalls, <=89 total opens and <=89 closes. Errors consume quotas.
- Before additional directory acquisition or file IO, stop if monotonic elapsed exceeds200ms. This is a **soft no-more-work threshold**, not a syscall deadline: synchronous proc open/read/close may block or overrun it, and cleanup still closes acquired FDs. Actual durationMs is reported. No claim of a hard wall-clock upper bound is made.

The result includes candidates, rejected, readErrors, capped, state and durationMs. Missing root data yields unavailable; malformed or unreadable descendant data is omitted and reflected in rejection counts. `observed` never means complete. Platform/non-main-thread unsupported performs no proc IO. Each output is <=2048 bytes per sink, <=32 records, <=128 KiB combined for this separate channel. Budget preflight occurs before any descendant reads; original trace exhaustion stops collection. Combined maximum including preserved #436 channels is4 MiB+32 KiB+256 KiB+16 KiB+128 KiB. Failed observations do not alter tests or their exit code, but diagnostic IO has bounded nonzero overhead.

Local Node22.23.3 contract tests cover identity/membership changes, malformed comm/IDs, privacy, count/depth/read limits and output gating. A real owned-child fixture allocates16 MiB, verifies the observed identity/RSS, terminates its own child, and verifies the held proc descriptor cannot read an exited process. This cloud executor does not expose task children (ENOENT), so that fixture is explicitly skipped locally. On GitHub Ubuntu, missing children support fails this new diagnostic acceptance instead of pretending to have attribution. No existing timeout, concurrency, heap setting, assertion or test glob changes.

## Evidence-driven follow-up: one candidate's PID and case receipts

The first #438 run (38838571352, aggregate116773124463) captured direct child PID9135/PPid2946/startTicks19448 growing from10,517,736 KiB RSS at02:07:57.882 UTC to15,157,132 KiB RSS and1,887,660 KiB Swap at02:08:14.418 UTC. Host AnonPages reached15,417,696 KiB while MemAvailable fell to281,080 KiB. Both child samples had0 rejected/read errors and no cap. Shutdown143 followed at02:08:26.407 UTC. The only unmatched wrapper in both windows was imzenx-ui, but that is a strong candidate, **not an explicit PID-to-file mapping**. No OOM initiator is established. The run ended6/8; Windows packaged smoke independently failed. The real owned-child fixture's wrapper completed, but buffered case output prevents asserting its individual success.

The next head is a distinct evidence-driven experiment, not a blind retry: only imzenx-ui.test.ts adds beforeEach/afterEach hooks and an after close hook. Every original test callback, assertion and await remains intact. A fixed whitelist maps the20 existing source case names to numbers1–20; no test name or payload is copied into receipts. File-start uses0. A case-complete receipt means the afterEach lifecycle was reached, **not that the test passed, descendants exited or memory was released**. Missing starts/completes remain unknown, including module import failures before hook registration.

The reporter's existing start record gets a fresh random UUID only when this diagnostic is enabled. The child reads at most1024 bytes from the already-configured trace file and accepts only its complete first start line/runId. It reads its own fixed proc stat via a held directory FD and validates PID/PPid against the process. It exclusively creates `<trace>.imzenx-<runId>.ndjson` with O_EXCL/O_APPEND and0600. Old-run files have a different nonce; creation failure produces no new attribution. The parent must also have successfully created its own trace, and validates exact nonce, fixed file, PID/PPid/start ticks against the current anchored descendant sample. The nonce is a correlation identifier, not a credential or permission grant.

Writer limits are41 lines (file-start plus2 percase), <512 bytes each (internally480-byte maximum before parent kind prefix), and21 KiB reserved total. Each receipt is one synchronous append write; a short write/error permanently stops and closes this writer. No completion is synthesized. Duplicate/invalid IDs and repeated phases do not expand the budget. The after hook closes the FD on normal file lifecycle; process teardown closes it after crash/termination. This small append does not claim a transactional filesystem: the reader ignores the incomplete final line and validates all complete rows before accepting any new receipts.

Only the existing successful15-second resource opportunity may read the fixed nonce sidecar, after the owned-process snapshot. No timer, global preload, process argument read or main trace concurrent write is added. Each attempt uses a single O_NOFOLLOW file descriptor, at most2 read syscalls, at most32770 bytes including overflow detection; at most32 attempts, each preflighted against an independent80 KiB combined-output/80-record/512-byte-per-sink budget. Parse accepts only exact field names, fixed phases, UTC shape, monotonic sequence and legitimate start/complete pairs. It outputs each accepted sequence once plus bounded observation states (unavailable/unmatched/invalid/partial/observed). Missing support or mismatched identity is unknown, never fallback PID guessing. IO remains synchronous without a hard wall-time guarantee. The previous descendant/data limits remain unchanged; this sidecar is an explicitly additional bounded read/output channel. No raw parse errors, unknown fields, environment values or arbitrary file paths are emitted.

Local Node22.23.3 ran all20 unchanged IMZenX cases successfully in4.75 seconds and generated41 sidecar lines (max214 bytes), verifying registration/close behavior. This remains an isolated1536 MiB diagnostic run, not reproduction of CI pressure. Sidecar contracts separately cover stale run IDs, partial tail, unexpected fields, duplicate phases, write failure and pre-IO budget checks. No new CI is triggered until independent review of this exact head.
