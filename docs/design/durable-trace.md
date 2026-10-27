# Durable local Trace

Trace is always-on local evidence, not a debug-panel feature. The panel and `trace_read` are readers. A request made before a panel was opened remains readable after restart.

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

Metadata polling can skip artifact verification explicitly. Opening artifacts verifies their content. Bounded range reads hash the complete artifact while retaining only the requested page in memory. `trace_read` accepts a trusted current-thread reference to one exact observed tool call, not arbitrary paths/thread IDs; returned binary and split UTF-8 ranges are base64 with explicit offsets. It grants no execution authority.

## Privacy and publication

Local capture does not redact body fields merely because they are named `password`, `token` or similar. Authentication credential header omission is explicit in request metadata (`authorization`, `proxy-authorization`, `x-api-key`, `api-key`). First-party requests currently send the configured key/access token as Authorization Bearer. Other headers, including cookies, are not silently omitted; there is no general body redaction. Credentials are not model-context content.

External publication/export must be a **separate sanitized, reviewable copy**, never the private live Trace directory. The implementation has no automatic public export. Development fixtures are synthetic: no real credentials, user screenshots, private traces or real application state belong in GitHub.
