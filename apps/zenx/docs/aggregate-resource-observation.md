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

## First bounded file-concurrency experiment

The main `5450d180` aggregate [job 116641447370](https://github.com/albert-zen/zen/actions/runs/38798601892/job/116641447370)
recorded host-visible available memory falling from 8,211,172 KiB at
20:06:07.592 UTC to 269,132 KiB at 20:06:23.194, while swap use grew from zero to
1,174,888 KiB. Shutdown occurred 13.916 seconds after that last sample. Cgroup
counters were unavailable. This supports investigating memory pressure; it does
not prove OOM, identify a responsible file/process, or establish the shutdown cause.

Only `test:prepared:observed`, used by the existing CI `check:observed`, now sets
`--test-concurrency=2`. Normal `test` and `test:prepared` keep their original command.
This is the first bounded, single-variable acceptance experiment, not a proven
permanent fix. [Node 22.23.3 documents](https://nodejs.org/download/release/v22.23.3/docs/api/cli.html#--test-concurrency)
that this flag limits concurrently executing **test files**, normally separate
processes, with a default based on available CPU parallelism. It does not cap every
nested subprocess or change a file's own `test()` concurrency options. CPU count
and per-child heap limits were not measured in the failed job, so no exact heap
multiplier is claimed.

All original file globs, tests, assertions, process isolation, TAP and resource
receipts, preparation/typecheck/build order, and the original 20-minute job limit
remain in place. There is no added filtering, shard, skip, timeout relaxation,
force-exit, heap limit or automatic retry. Existing script-contract tests require
exact observed argv and unchanged normal commands and CI timeout.

Acceptance requires the complete original suite and build to finish inside that
limit on the exact candidate, with no failed checks. Compare memory/swap receipts
and note their age and budget gaps; absence of a late sample is not proof of low
pressure. Passing establishes only that the configuration worked on that run.
Failure or timeout remains a failure, and requires evidence review before another
change. Do not rerun an old shutdown run as a substitute for this source change.
