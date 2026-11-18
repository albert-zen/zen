# Isolated 5,000-history verification

## Result

- **Canonical append: passed in isolation with `--max-old-space-size=4096`.** One named test passed, zero failed. Test duration: 37.050 seconds. Whole process wall time: 44.62 seconds. This was the single bounded larger-heap retry.
- **Tool results: failed in isolation at the default heap.** The fresh test process exhausted the V8 JavaScript heap and aborted with `SIGABRT`, after 70.74 seconds wall time. The runner reported zero passes and one test-process failure; no assertion failure was reported before the resource failure.
- **Canonical append at the default heap: outcome unknown.** The executor session was lost before it returned a result. Its output and timing files are empty. There is no evidence to classify this attempt as an assertion failure, heap failure, or pass.
- The tool-results failure in a fresh process demonstrates that the default-heap problem is not solely accumulation from the preceding suite tests. These isolated checks do **not** constitute a full-suite pass. The earlier full-suite interruption remains unresolved.
- Both complete 5,000-history test blocks already existed and are unchanged from `d7f93b83` to `58df4ea3`. The earlier revision was not executed for comparison, so this evidence does **not** establish whether the memory failure is a product regression.

## Scope and identity

- Repository: `/workspace/scratch/72527d3ea90a/ui-quality-iteration`.
- HEAD before and after checks: `58df4ea3852e4826d3aa31a931c3383258bc0c47`.
- Test file: `apps/zenx/test/app-project-picker-interaction.test.ts`.
- Test-file Git blob, both working file and HEAD: `667f4fbdcddea5eeecff72c9a7b341c18af96e80`.
- Node: `v24.22.1`.
- The working test file matches HEAD. A final `git diff --exit-code HEAD -- apps/zenx src packages` succeeded, and those paths had no status entries.
- No source, dependency, application, or test edits; no application launch, CUA, commit, or push. Existing documentation/evidence changes in the repository were left alone. The full suite and the optional smaller-history case were not rerun.
- Both exact-name cases have their existing 180,000 ms test timeout. Each invocation also had a 240-second wall-time limit, with TERM followed by KILL after 15 seconds if necessary.
- Isolated writable npm cache: `/workspace/shared/ui-quality-evidence/large-history-npm-cache`.

## Commands and outcomes

All commands below were run from the repository root. The successful timing harness used Bash's built-in `time -p`, with test stdout/stderr redirected to each `.log` file, timing stderr to `.time`, the command exit status to `.exit`, and UTC `date -u +%FT%TZ` markers to `.started` and `.finished`.

### 1. Canonical append, default heap

```sh
timeout --signal=TERM --kill-after=15s 240s \
  env -u NODE_OPTIONS \
  npm_config_cache=/workspace/shared/ui-quality-evidence/large-history-npm-cache \
  node --import tsx --test \
  --test-name-pattern='^real App canonical append preserves 5000 historical Turn and message renders$' \
  apps/zenx/test/app-project-picker-interaction.test.ts
```

- Started: `2026-11-09T17:55:23Z`.
- No heap override. A separate default Node probe reported a V8 heap-size limit of `2348810240` bytes.
- Completion, exit status, and elapsed time: **unavailable**. The tool returned `exec-server transport disconnected; failed to resume exec-server session: exec-server protocol error: executor key changed during session recovery`.
- Checked the preserved markers and empty output before retrying. No completion marker or exit status for this actual test attempt was recovered.
- Logs: `large-history-isolated-default.log` and `large-history-isolated-default.time` are empty. `large-history-isolated-default.started` records the launch timestamp.

An earlier optional `/usr/bin/time` profiling wrapper was unavailable and exited 127 **before launching Node**. That diagnostic is retained separately as `large-history-isolated-timing-wrapper-unavailable.log`, `.exit`, and `.finished`. Its exit 127 is not a test result. The wrapper was replaced with Bash's built-in timing before the actual default-heap attempt.

### 2. Canonical append, one bounded larger-heap retry

```sh
timeout --signal=TERM --kill-after=15s 240s \
  env -u NODE_OPTIONS \
  npm_config_cache=/workspace/shared/ui-quality-evidence/large-history-npm-cache \
  node --max-old-space-size=4096 --import tsx --test --test-reporter=tap \
  --test-name-pattern='^real App canonical append preserves 5000 historical Turn and message renders$' \
  apps/zenx/test/app-project-picker-interaction.test.ts
```

- Started: `2026-11-09T17:57:18Z`; finished: `2026-11-09T17:58:02Z`.
- Heap setting: 4,096 MiB old-space maximum. A matching Node probe reported V8 heap-size limit `4496293888` bytes.
- Available memory immediately before the retry: 7,514 MiB, with no swap. The retry was sequential, not parallel with the other isolated case.
- Exit: `0`; TAP: `tests 1`, `pass 1`, `fail 0`.
- Test duration: `37049.767889 ms`; TAP total duration: `44364.662384 ms`.
- Built-in timing: `real 44.62`, `user 48.94`, `sys 14.87` seconds.
- Diagnostics confirmed historical turn render numbers `[5000]` for the started/new-input phases and `[5000,1]` for late backfill, alongside the test's assertions.
- Logs and markers: `large-history-isolated-4096.log`, `.time`, `.exit`, `.started`, `.finished`.
- Log SHA-256: `2a37e8504b7b83193cc05c4dd642fee2c99ee73fc5f8439a6e371400ec030d1a`.

### 3. Tool results and late quotes, fresh default-heap process

```sh
timeout --signal=TERM --kill-after=15s 240s \
  env -u NODE_OPTIONS \
  npm_config_cache=/workspace/shared/ui-quality-evidence/large-history-npm-cache \
  node --import tsx --test --test-reporter=tap \
  --test-name-pattern='^real App tool results preserve 5000 historical Turns and keep late tool quotes current$' \
  apps/zenx/test/app-project-picker-interaction.test.ts
```

- Started: `2026-11-09T17:58:21Z`; finished: `2026-11-09T17:59:32Z`.
- Heap setting: default, with `NODE_OPTIONS` removed, as in attempt 1.
- Available memory immediately before launch: 7,515 MiB, with no swap.
- Exit: `1`; TAP: `tests 1`, `pass 0`, `fail 1` at the test-file/process level; signal `SIGABRT`, code `ERR_TEST_FAILURE`.
- Fatal diagnostic: `Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory`.
- Final GC diagnostic: approximately 2,021 MiB live heap after mark-compact, with 2,054.8 MiB heap capacity.
- Test-process duration: `70608.163001 ms`; TAP total duration: `70621.63614 ms`.
- Built-in timing: `real 70.74`, `user 172.19`, `sys 4.30` seconds.
- Logs and markers: `large-history-tool-results-default.log`, `.time`, `.exit`, `.started`, `.finished`.
- Log SHA-256: `920271f41702dd65d301554776924aa0456bc0ce6c22f9825656410e93314b7d`.

## Read-only baseline source comparison

Compared the complete named test blocks returned by these commands, without checking out another revision or running it:

```sh
git show d7f93b83:apps/zenx/test/app-project-picker-interaction.test.ts
git show 58df4ea3:apps/zenx/test/app-project-picker-interaction.test.ts
```

- Baseline full SHA: `d7f93b83f54ba873b61f19bd72ac3a6f6010aa4a`.
- Final full SHA: `58df4ea3852e4826d3aa31a931c3383258bc0c47`.
- Canonical append: identical complete 247-line test block. Start line moved from 8,411 to 8,705. Matching block SHA-256: `ea0546e141228665eb5d6eb1a13d135cdaec4eea37c14e15dc3ad4aadd335d6b`.
- Tool results: identical complete 263-line test block. Start line moved from 8,659 to 8,953. Matching block SHA-256: `64fed1713c854eb31bbe9f6b141cbdd02e1ddb2a2ea21e5a935c4bdf0335041e`.
- Comparison excluded only whitespace after the complete test blocks. No internal code or whitespace was normalized.
- Machine-readable evidence: `large-history-baseline-comparison.json`.
- Identical test bodies do not establish identical application behavior or resource requirements. No baseline execution was performed, and the failure is not classified as a product regression.

All listed logs are under `/workspace/shared/ui-quality-evidence/`. No additional retries were run after the tool-results default-heap failure.
