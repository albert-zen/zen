# Synthetic capture readiness and failure attribution

This is fixture infrastructure, not a production browser or UI timeout change.

## Evidence and limits

Issue #482 records Chrome sometimes announcing DevTools only during cleanup after
our old 200 × 50 ms poll had failed. The #499 file-sidebar first-attempt artifact
likewise has zero UI cases and `DevTools listening` only in its final stderr log,
not its captured failure message. In #489 run 40178030267, original approved-UI
startup failed after approximately 10 seconds with empty stderr; the one allowed
rerun failed at the same phase with one D-Bus warning. This establishes a premature
readiness decision and inadequate diagnostics, not a proven D-Bus/OS root cause.

Main run [42243745815](https://github.com/albert-zen/zen/actions/runs/42243745815)
at `53c99e24` exposed starvation inside the later shared 30-second budget:
layout/overflow first Chrome ports appeared at 24.537/29.437 seconds, leaving
5.463/0.563 seconds for target discovery and handshake. Both captures remained
`not-started` and cleanup completed. In the same jobs, subsequent file-sidebar
and foreground captures reached the port in 208/204 ms and connected in
1421/1275 ms. The conversation runner's first capture connected in 5545 ms.
Successful captures also logged the same invalid D-Bus address errors. These are
cold-start correlations, not proof of a D-Bus defect or CPU/IO root cause. The
three shards used distinct hosted workers and Azure regions, not one shared VM.

Connection readiness now has fixed monotonic phase budgets: port discovery 30
seconds, target discovery 10 seconds, and one WebSocket handshake 5 seconds,
with a 45-second overall connection ceiling. Each phase starts once; polling
never renews it. An explicit `timeoutMs` remains an overall ceiling, including
for existing callers/tests requesting a shorter bound. Every completed read and
handshake must still be inside its phase and overall deadlines before advancing.
Child exit/error interrupts pending readiness I/O; supported I/O is aborted.
HTTP observations, including response bodies, remain bounded at two seconds or
the smaller remaining budget. Chrome is spawned once and the socket is connected
once. Only read-only readiness observations repeat; captures and mutating CDP
commands never retry. These are reliability bounds, not a speed improvement or
measured startup percentiles. Existing CI job deadlines remain unchanged.

The 45-second ceiling ends at connection readiness, not completion of the UI
capture or cleanup. Page setup keeps existing per-command CDP deadlines; artifact
writes have no new deadline. Do not describe this as a whole-task time guarantee.

## Receipts

All five launch paths write `browser-lifecycle.json` and `chrome.log` alongside
existing screenshots/measurement receipts. The existing always-upload artifact
steps include these files without a workflow change. The lifecycle receipt records
spawn, DevTools port, HTTP target list, WebSocket connection, page setup and capture
phases, elapsed time, last read-only observation, last CDP method (not its payload),
exit/signal, capture status and cleanup result. Startup failure leaves capture
`not-started`; it is not a product assertion failure. A capture failure retains
existing per-case measurements/failure screenshots. `chrome.log` is an explicitly
bounded 64 KiB stderr tail; no credentials or private profiles are used by fixtures.

Cleanup sends TERM, waits up to five seconds, then sends KILL only if still alive
and waits up to two more seconds for close (including stderr drainage). An unreaped
process is recorded, its profile is retained rather than deleted underneath it,
and a previously successful capture cannot turn cleanup failure into a green run.
The original capture/startup failure remains primary when cleanup is incomplete. Artifact write errors are retained in the receipt when possible and printed to stderr; both artifact writes are attempted. Every caller closes its HTTP server and removes a safely reaped profile in a nested finally, independent of artifact persistence. Artifact write failure also blocks a green capture.

Launch flags are unchanged: four standalone captures keep sandboxing enabled;
the older shared `preview-browser.mjs` already passed `--no-sandbox` and this PR
neither introduces nor removes that existing flag. No production browser
configuration, 15-second CDP request budget, UI assertion, fixture wait or screenshot
expectation changes. In particular this does not address the separate macOS
production CDP mutation timeout/late-reply investigation.

## Verification

`node --test apps/zenx/test/preview-browser-lifecycle.test.mjs` covers delayed
readiness beyond the old budget, never-ready/invalid port, early exit and spawn
failure (including real Node subprocesses), transient HTTP/no-target observations,
bounded HTTP and WebSocket hangs, phase attribution, and TERM/KILL/unreaped cleanup.
Tests use synthetic process/CDP fixtures, not a downloaded browser. Real captures
remain GitHub-Actions-only; their assertions must pass on the new revision before
merging. A previous branch's failed job is not silently retried by this helper.

## Cold-start measurement plan (not implemented by this patch)

Do not warm up Chrome, rerun failures until green, or discard first samples.
Before changing launch environment, collect fixed-size numeric observations for
the first and subsequent fresh-profile launches on each worker: Chrome version,
runner image, phase durations, process CPU time, CPU quota/count, memory/IO
pressure and startup ordinal. Record only whether a D-Bus session address is
absent or its transport type, never its value or arbitrary environment contents.
Keep instrumentation cost visible and preserve all failed samples.

A controlled D-Bus comparison should use matched fresh workers and fixed Chrome,
fonts and fixture revisions, comparing inherited environment with a private
session bus in alternating order. A new profile is not a cold disk/font cache;
label that difference instead of claiming a warm second launch is equivalent.
Compare time-to-port and time-to-target distributions and failure rates, not just
successful total wall time. Do not change sandbox/security flags or lower UI
coverage. Require evidence of reduced startup time before calling any such
change a speed improvement; the current phase-budget patch makes no such claim.
