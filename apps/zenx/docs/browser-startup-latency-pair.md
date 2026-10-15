# One paired macOS startup observation

Diagnostic only. Keep this branch draft and unmerged. It reuses the owned,
one-shot replica from PR #329; the old experiment is not run again. Production
CDP deadlines, cleanup, and ordinary browser acceptance are unchanged.

## Question and observation

PR #357's Mac run 38545684358 / job 115791029279 observed Page.enable in 2435ms,
Runtime.enable in 2037ms, then no Page.createIsolatedWorld reply within its two-second
outcome deadline. This is not evidence for a particular cause.

One newly opened same-repository draft PR runs up to two separate CLI processes:
`title`, then `pid-only`. Each builds its own private native helper and starts a
new Chrome/153.0.8010.12 with a freshly created disposable profile and local fixture
server. Neither uses a personal profile, signs in, requests OS permissions, or
runs native input. Existing Accessibility trust is required for this comparison.

Both keep the 10ms foreground-PID sampling and the same forced renderer AX setup.
The baseline additionally reads the owned focused-window title through AX, as in
ordinary acceptance; the control omits only those title reads. The control's
private helper rejects every native type request. Ordinary smoke uses its original
native helper source, not the diagnostic transformation.

Each replica creates one inactive target with a synthetic local page and sends
Page.enable, Runtime.enable, Page.getFrameTree, then Page.createIsolatedWorld at
most once each. The frame URL must match that exact newly created fixture marker.
Each stage retains the original two-second diagnostic outcome deadline. The first
unknown outcome stays unknown permanently, even if its original reply arrives
within five more seconds; no later initialization stage follows it. There is no
input, evaluation, navigation, retry or replay after that unknown.

A single browser-scoped Browser.getVersion probe runs beside the isolated-world
request, or at an earlier initialization deadline. A timeout can additionally
send one same-session Runtime.getIsolateId read-only probe, as in the original
replica. These probes are explicit instrumentation, not passive observation.
Reports retain anonymous route aliases, per-request elapsed times, exact stage
outcomes, Node event-loop delay (10ms resolution), total/max AX read duration,
foreground drift, and detach outcome. No page contents, actual target/session
identifiers, raw error text, credentials, or user data are recorded.

## Interpretation and stopping rule

A responsive browser probe with a slow target request and low Node event-loop lag
supports a target/renderer-side delay. Delayed browser and target replies can
indicate a broader stall; high Node lag makes client scheduling a confounder.
These observations do not independently establish CPU saturation or causality.
A difference between the two cases supports investigating AX polling, but order,
warm caches and runner scheduling are not controlled by one pair.

Stop after this one pair, including non-reproduction. Setup/foreground/cleanup
failure stops the workflow rather than retrying. A valid unknown-outcome receipt
ends that case after bounded original-reply observation, then the other fresh
profile can provide its independent observation. The workflow only accepts the
exact branch's draft `pull_request: opened` event and `run_attempt == 1`; there is
no synchronization, push, dispatch, or probability rerun trigger. Existing normal
CI runs separately and none of its gates is waived.

The synthetic target is created directly at its local URL. This differs from the
production blank-target-then-navigation sequence and is not a full product startup
reproduction. Neither two passes nor a successful normal CI run closes the
intermittent startup issue. Retain the report as bounded evidence for the next
specific fix or an honest unresolved result.
