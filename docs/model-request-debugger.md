# Durable local Trace reader

The debugger reads persisted evidence; it does not wrap adapters, enable capture,
evict history, clear originals, replay tools, or own execution. Closing it and
restarting the Host do not change the evidence source. Durable logs are the fact
and recovery authority. Queue/configuration/current UI state are projections or
caches, never another authority that can replace failed durable control writes.

## Three separate observations

- **Sample outcome:** completed, failed, cancelled, consumer cancelled, unknown.
- **Dispatch evidence:** prepared request bytes alone do not prove dispatch.
  `model_request_dispatched` observes a fetch invocation, not provider receipt.
  `model_dispatch_blocked` means the attempt did not invoke fetch.
- **Raw response capture:** complete only with that attempt's explicit response
  end; semantic model completion and HTTP EOF can happen at different times.

Cold unfinished history is unknown, not running. A previous retry's EOF cannot
close the next attempt. Whole-sample client elapsed time includes local capture
and provider work. Attempt duration uses a single monotonic clock domain and
labels preparation-to-block separately from invocation-to-capture-end.

## Read API

`new ModelRequestDebugStore(traceReader).control(command)` is asynchronous:

- `{action:'status'}` reads current writer health (not historical integrity).
- `{action:'list',threadId,mode?:'requests'|'events',query?,offset?}` reads a
  bounded metadata page. Empty threadId explicitly means all-local, including
  auxiliary title/probe scopes. Search is metadata-only, not body search.
- `{action:'read',threadId,id,view?,offset?,artifactIndex?}` reads only the selected
  record's owned evidence. Views: payload, messages, tools, configuration,
  output, timeline, artifact. No arbitrary path or caller-provided artifact ref.

Actual request bodies are never reconstructed from semantic model inputs.
Adapter input artifacts are labelled non-HTTP and available as original
artifacts. Request/output pages preserve exact UTF-8 including BOM; undecodable
bytes are reversible Base64. Structured views are explicitly presentations.
Only API-key auth headers are omitted locally. Bodies are not broadly redacted;
export sanitization is a separate explicit action.

Indices verify stored frames without loading every artifact. Every explicit
artifact read verifies hash/length. Integrity gaps and unavailable bytes remain
visible. Existing bytes and known model outcomes survive incomplete raw capture.

## Desktop boundary and presentation

The renderer IPC handler verifies owned app window + main frame + exact trusted
renderer URL before validation/read. Webviews and foreign/subframes cannot read
all-local traces. The Host IPC awaits disk reads. The UI displays current settings
separately from frozen captured settings, ignores stale thread/navigation replies,
and never upgrades old displayed bytes with a newer polled status. Reload selected
evidence explicitly refreshes both. Raw content is escaped React text.

## Acceptance

Use synthetic fixtures only. Reader tests must reopen actual files, cover retries,
lossless bytes, scopes, missing/corrupt evidence and separated completion states.
Production-component interaction tests cover empty/error, close/reopen, focus,
thread switching, stale async responses and tool/title scopes. Screenshot evidence
must come from the actual component bundle at the accepted source SHA; a prepared
HTML fixture or JSDOM pass does not establish visual acceptance.
