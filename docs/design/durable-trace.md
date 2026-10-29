# Durable local Trace

Trace is always-on local evidence, not a debug-panel feature. The panel and ordinary shell/file tools are readers. A request made before a panel was opened remains readable after restart.

## Authority and domains

The model-context ItemList contains semantic inputs. Trace contains the durable factual log, including application/control facts and execution observations. Application state is a projection/cache of those facts, not another independent recovery authority. There is no additional Execution or RunState journal.

`RuntimeTrace.record` returns a receipt. A `durable` receipt acknowledges the frame and its referenced artifacts after synchronization. A `degraded` receipt is **not proof that nothing was written**: a write may have reached disk before a later operation failed. Application/control success acknowledgments must require durable facts and reconcile exact existing facts before retrying an uncertain operation. Ordinary observation failures may explicitly degrade and allow inference to continue.

A Trace fact is evidence, not permission to repeat a side effect. Only an exact local `tool_result_accepted` fact with a verified artifact can supply a known terminal result. Missing, corrupt, unmatched, or imported evidence does not establish nonexecution. Recovery must never blindly replay a tool.

Credentials and external provider validity are a separate existing authority, not recovered permission from historical logs. The current credential file gains only a session identity: login replaces it, same-account refresh preserves it, logout removes it. Every new dispatch checks current session/account plus the provider membership guard synchronously after awaited request capture. Logging failure cannot preserve logged-out authority. Login/logout/refresh observations contain session/account attribution, never authentication secrets.

## Capture boundaries

- `model_request` records the actual serialized string passed to Fetch and its metadata **before dispatch**. `model_request_dispatched` means the Fetch function was invoked, not that TLS wire bytes or server receipt were observed. Revocation while capture is pending leaves prepared bytes and an explicit blocked event, with no dispatch claim.
- First-party adapters send immutable JSON strings. Unknown nonstring request bodies are passed unchanged and receive an explicit capture gap; Trace does not separately encode FormData or consume a Request and pretend those bytes were sent.
- Response artifacts contain bytes exposed by Fetch before parser decoding. They are not TLS packets and may already have undergone transport decompression. Chunks are awaited with backpressure; there is no unbounded tee or cumulative stream snapshot.
- Protocol completion and raw EOF are separate. A parser terminal event can finish model work while an owned tail reader continues. Host shutdown closes those readers before flushing Trace. Cancellation, network failure and shutdown record interrupted capture and the actual offset, never a fabricated EOF.
- Exposed model events, reasoning summaries/opaque continuation, attempts, provider errors, frozen effective settings, selected context identities and client timings are recorded. Trace does not claim hidden reasoning, server queue duration, or exact network-only latency.
- Shell stdout/stderr bytes are captured before UTF-8 decoding and before bounded model-facing spool output. Pipes pause until recording settles. PTY and generic task callbacks expose decoded text, not original pipe bytes; their capture layer says so. Nonpausable callbacks have a bounded pending budget and explicit missing byte ranges if exceeded. Existing process deadlines, cancellation semantics and model-output limits remain in force.
- Tool returned values are retained before model projection/normalization. V8 serialization records the returned JavaScript value; a separate JSON view is only a reader convenience, not a claim about transport bytes. Unserializable values, unavailable media and already-truncated upstream spools produce explicit gaps. Media is copied into Trace ownership, independent of temporary spool lifetime.

## Storage and time

Each thread/auxiliary partition has append-only writer segments. Frames carry a content checksum; artifacts are content-addressed, but every actual occurrence keeps its own record. An interrupted frame remains visible as incomplete; a new writer does not append behind that damaged tail. No retention eviction or truncation is called “full.”

Artifact creation, deduplication, import and reading require owned regular files. Symbolic links, multiply-linked files and aliased owned directories are rejected rather than acknowledged as independent copies. Import copies bytes and preserves origin/clock attribution; source deletion cannot remove an acknowledged independently owned destination artifact.

Durability receipts describe synchronization scope: POSIX file and directory synchronization, or file synchronization where directory synchronization is not available. Synthetic tests cover process exit/restart, partial frames and interrupted/corrupt artifacts; they do not promise untested hardware, filesystem or power-loss guarantees.

Durations within one process use monotonic nanoseconds. Every writer has an explicit clock domain and wall time for display. Cross-process ordering must not subtract unrelated monotonic clocks or pretend wall clocks provide exact elapsed time.

Metadata polling can skip artifact verification explicitly. Opening artifacts verifies their content. Bounded range reads hash the complete artifact while retaining only the requested page in memory. Model receipts expose existing same-Host JSON/text artifact paths for ordinary shell/file inspection, without a dedicated model Trace reader. These paths preserve raw pre-projection results and explicitly distinguish preview truncation, upstream source truncation, and capture gaps. They grant no execution authority and do not claim remote spool bytes that were never received.

## Privacy and publication

Local capture does not redact body fields merely because they are named `password`, `token` or similar. Authentication credential header omission is explicit in request metadata (`authorization`, `proxy-authorization`, `x-api-key`, `api-key`). First-party requests currently send the configured key/access token as Authorization Bearer. Other headers, including cookies, are not silently omitted; there is no general body redaction. Credentials are not model-context content.

External publication/export must be a **separate sanitized, reviewable copy**, never the private live Trace directory. The implementation has no automatic public export. Development fixtures are synthetic: no real credentials, user screenshots, private traces or real application state belong in GitHub.

## UI activation and Host ingress

A synchronous Composer/manual-retry handler captures a fresh renderer clock-domain,
local monotonic time and wall time before asynchronous preparation. This is reported
UI evidence, not proof of a human actor. A small native observation message can
retain activation before Thread creation (the `ui-activations` Trace partition),
without admitting input, starting a model sample or copying a message body.
The actual input request separately carries that observation and receives an
independent Host receipt clock. Client and Host clocks are never subtracted as
network latency. An absent input receipt means unobserved, not safely cancelled.

Native send/retry/queue edit/cancel/steer receipts retain exact admission outcomes.
Accepted queue or cancellation is not model completion; ambiguous replies remain
unknown. Malformed optional timing cannot change input authority. Capture failures
are explicitly reported, but these passive observations neither authorize replay
nor replace the durable control facts that govern admission.

The timing reader pairs exact sample/span IDs and shows preparation, semantic
materialization and compilation separately from adapter sampling. It associates
admitted input client IDs without asserting that each input caused the sample.
For one selected transport attempt it shows actual Fetch invocation, headers,
first nonempty response bytes, first nonempty exposed reasoning/summary/text,
sample finish and raw EOF independently. Empty deltas and opaque continuation are
not exposed reasoning. Older missing markers stay unobserved. Fetch/header boundary
clocks are captured before awaiting their recording; no observation await is placed
between the final authorization check and Fetch. Same-clock intervals include local
capture/processing and provider work, not DNS/TLS/server-queue decomposition or
exact model token-generation timing.

## Sidebar committed state facts

The existing main-owned `ThreadSidebarStore` reads committed `sidebar_state_changed`
patch/state facts from the same `.zen/trace` facility, in partitions derived from the
existing typed Thread/Room owner key. These partitions are not Agent Threads. The
existing revision is still only the sidebar CAS contract; no general version ledger,
scheduler or model Item is added. The current map and tagged JSON snapshot are caches.
Durable acknowledgement precedes cache publication and notifications. An unconfirmed
append fails the request and invalidates its cached projection; the next read reconciles
the exact log before another CAS decision, never automatically repeats a side effect.
A corrupt/inconsistent log does not fall back to a snapshot. A cache write failure after
a durable fact is diagnostic, not a rollback or failed state change.

A pre-existing untagged sidebar snapshot seeds one `sidebar_state_imported` fact with
its exact source bytes and explicit legacy-file provenance. Its original activation
time is unavailable; the record clock is import time, not a fabricated historical UI
click. A tagged cache cannot seed missing authority. UI IPC fixes source to `ui`, and
self-control fixes source to `tool` plus its trusted invocation Thread/call IDs. Neither
label claims a human actor; renderer payloads cannot submit arbitrary source facts.
Owner isolation, Room scope checks, admission timing, tabs and stale-CAS behavior are
unchanged. Shutdown fences new sidebar calls, drains admitted owner queues and flushes
the same Trace writer before exit.
