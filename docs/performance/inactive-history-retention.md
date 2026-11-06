# Inactive history retention (#707)

This is a partial resolution of #707. The original measurements below compare
`d8e83eca` with the initial cache implementation. The current draft integrates that
implementation on `02827ec7`, including #711–714. It does not replace #711's
lightweight sidebar reads or #712's historical pagination.

## Changes and safety boundary

- AppServer keeps four hot Thread objects. A weak lookup preserves the exact
  object while an active Turn, queued operation, preparation, reader or mutation
  still owns it. This avoids evicting an object across an asynchronous write and
  falsely invalidating its authority. Explicit uncertain-write invalidation still
  removes both lookup paths. Collected histories reopen from the durable journal.
- Domain journal keeps one most-recently-written reconstructable canonical
  history, rather than every written Thread. Failed optional Trace observations
  protect their process-local history because it cannot be reconstructed.
  Migration no longer retains a full live history (same change as #711).
- Completed Domain serialization chains discard results and remove their keys.
  Previously the fulfilled Promise could retain a full append semantic receipt.
- A combined cold read reuses one serialized reconciliation's Trace observation
  for canonical and semantic history. It does not cache source validation across
  operations. Unpublished imports remain unavailable, and damage still blocks
  compilation and recovery.
- Renderer keeps four inactive histories plus the selected history, active Turns,
  queues, unresolved submissions and compactions. Composer and side-chat drafts
  remain separate. A return to an evicted history uses normal native recovery.

This bounds counts of reconstructable inactive histories, not the size of one
long history or the amount of genuinely active work. Weak references are reclaimed
by GC, not immediately at navigation. Non-durable observations are intentionally
not discarded to meet a memory budget.

## Reproduction

The Node harness uses 256 completed Turns per Thread, two text messages per Turn,
1,025 canonical facts, and approximately 2.59 MB of full snapshot JSON. Fixture
creation runs in a different process from read measurement. No model executes.

```sh
node --expose-gc --import tsx scripts/measure-inactive-history.mjs \
  "$PWD" /tmp/zen-memory-fixture prepare 32 0
node --expose-gc --import tsx scripts/measure-inactive-history.mjs \
  "$PWD" /tmp/zen-memory-fixture read 32 300000
HEAP_SNAPSHOT=/tmp/zen-memory.heapsnapshot \
  node --expose-gc --import tsx scripts/measure-inactive-history.mjs \
  "$PWD" /tmp/zen-memory-fixture read 8 5000
python3 scripts/attribute-inactive-history.py /tmp/zen-memory.heapsnapshot
```

Use a clean baseline checkout as the first argument to run the same harness
against it. Use fresh isolated directories for `prepare` and `write`. Concurrent
writers must not share one fixture directory. `write` creates each Thread and
appends one model-usage observation, exercising live history and append receipts.

`trace` opens the same 256-Turn workload with 12,000 extra diagnostic records.
`DIAGNOSTICS=0` selects its text-only control. Source reads remain complete and
fresh. The benchmark logs wall time, CPU time, RSS, peak RSS, heap, external and
ArrayBuffer memory separately. `HEAP_SNAPSHOT` writes a synthetic V8 snapshot.

## Observations (Linux, Node v24.22.1)

After visiting 32 histories, five cycles of revisits and five minutes idle with
forced GC:

| Metric                   |   Baseline |  Candidate |
| ------------------------ | ---------: | ---------: |
| V8 heap                  |  91.95 MiB |  30.09 MiB |
| RSS                      | 209.41 MiB | 138.71 MiB |
| Peak RSS during workload | 391.36 MiB | 414.39 MiB |
| External memory          |   7.40 MiB |   7.39 MiB |
| ArrayBuffers             |   3.33 MiB |   3.33 MiB |

Peak RSS did not improve. Reclaiming an old history trades retained memory for
new disk reads and decoding. In this run, the mean revisit time was 0.29 ms before
and 13.15 ms after; these are observations, not a stable latency guarantee.

Separate V8 snapshots after GC and five seconds idle establish the object-level
retention boundary. The attribution script removes the exact
`ZenAppServer.#threads` edge and sums the exclusively reachable graph's V8
`self_size`, excluding weak edges. This is not process footprint or Buffer size.

| Visited Threads | Baseline live Thread objects / exclusive graph | Candidate live Thread objects / exclusive graph |
| --------------- | ---------------------------------------------: | ----------------------------------------------: |
| 8               |                                  8 / 17.26 MiB |                                    4 / 8.64 MiB |
| 32              |                                 32 / 69.08 MiB |                                    4 / 8.65 MiB |

The candidate's 8-to-32 exclusive graph difference is 17,480 bytes, below the
issue's suggested 5 MiB Host target. The write workload's retained heap after
32 create+append operations was 83.02 MiB before and 14.66 MiB after.

Cold full history now performs one Trace read rather than two. The 12,000 extra
observations still increase retained heap by about 11.5 MiB and ArrayBuffers by
about 10.05 MiB. The existing verified-prefix cache remains bounded to 32 MiB of
source bytes and one Thread, and still retains decoded records. This change does
not claim to remove that cost. Repeated wall-clock/CPU timings varied materially
in the shared executor, so there is no claimed Trace latency improvement.

## Verification and remaining acceptance

### Original measured candidate

- 128 targeted compiled Node tests pass: cache reclamation, active Turn plus
  queued input across 32 other histories and forced GC, native recovery, forks,
  interrupted tools, queue edits/steering, deletion, context preparation,
  concurrent snapshot/append, detached reads, uncertain writes and Trace damage.
- 40 renderer tests pass, including actual App navigation through eight histories,
  a delayed fresh resume of the evicted first history, and preservation of its
  unsent Composer draft. Active/queued/unconfirmed histories remain protected.
- Root and ZenX TypeScript checks pass. These are focused checks, not the full
  repository aggregate or integrated #711/#712 acceptance.
- A real Chromium production-App memory benchmark was prepared, but Chromium
  aborted at startup because the executor denies its Unix socket creation. A
  permitted escalated launch encountered the same error. Therefore no renderer
  heap/RSS measurement or renderer retained-size target is claimed here.
- Real Electron WebContents count, images/decoded media, GPU contribution,
  macOS physical footprint and the original machine's paging behavior remain
  unmeasured. #707 must stay open for that acceptance rather than treating the
  Node result or DOM regression tests as proof of the full issue.

### Current-main integration

The code and tests at `4de29525` were verified against main `02827ec7`. The
integration preserves side-chat input ownership, native history windows and
summary revision handling. A non-promoting `has()` cache check supports the
summary checkpoint path without keeping inspected histories hot.

- 171 focused Host/core tests pass, including cache/GC, recovery and paging,
  stable earlier-page cursors after eviction, summaries, queue/fork/deletion,
  Domain reconciliation and Trace text storage.
- 151 focused renderer/IPC/attachment tests pass. A separate three-test cache
  run repeats two of those checks and adds one side-chat promotion regression:
  evicting idle history and closing the temporary presentation does not discard
  child text or a late image import.
- Root build, ZenX Node/Web typechecks, targeted formatting and whitespace
  checks pass. Independent integration review found no blocking issue; its
  87 focused tests and six cache/GC checks overlap the suites above.

These integration checks do not update the original memory measurements. No
full repository aggregate, remote CI, real-browser screenshot or renderer memory
measurement, Electron media/GPU attribution or macOS footprint acceptance is
claimed for this candidate. The PR remains a draft pending those acceptance
checks; #707 remains open.
