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

A single monotonic 30-second cold-start budget replaces the implicit 10-second
port-only loop. It covers port discovery, HTTP target-list readiness, and the
WebSocket handshake together; it is not 30 seconds per phase. HTTP attempts have
at most 2 seconds and are aborted within the remaining overall budget. Only
read-only readiness observations repeat. Chrome is spawned once; captures and
mutating CDP commands are never retried. CI's existing job deadline stays intact.
Thirty seconds is a bounded allowance for observed late readiness, not a measured
startup percentile or a guarantee that every future CI host starts successfully.

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
The original capture/startup failure remains primary when cleanup is incomplete.

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
