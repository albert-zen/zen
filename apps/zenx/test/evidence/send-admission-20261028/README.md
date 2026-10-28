# Send admission latency and ordering

Synthetic-only evidence. No user traces, settings, credentials, Provider calls,
or user computer access. Root owns browser screenshots and remote publication.

## Reproduced critical path

The production App awaited `titles.observe` before `zen/turn/send`. With title
persistence held for 200 ms, baseline dispatch took 223 ms idle, 216 ms steer,
and 260 ms new Thread; all three remained blocked until the auxiliary gate
opened. The fixed path took 2 / 1 / 14 ms respectively in the paired run.
These controlled measurements prove removal of that dependency, not device SLAs.

Separately, Runtime durably appends/emits `turn_started` before committing the
initial input. Production ThreadView previously displayed elapsed work during
that gap. It now shows Preparing without duration while the Turn has no input
or actual runtime content. The real input is rendered before the work header.
No success bubble, timestamp adjustment or runtime ordering change is used.

## Exact append receipt

A successful `DomainThreadJournal.append` returns the exact full semantic
snapshot read/reconciled inside that serialized append plus its newly durable
suffix. The AppServer consumes it once. There is no new cache, recovery state,
mutable authority or skipped durability/integrity operation. Other journal
implementations returning `void` use the unchanged `readItemList` fallback.
Uncertain or failed appends never return a receipt, still invalidate authority,
and never permit dispatch based on old state. Separate `appendContext` sources
are included in later receipts; explicit/cold compilation reconciliation remains.

The actual DomainJournal / FileTraceStore delayed-I/O test started RED: 20 ms
per Trace read produced 9 reads, 2 redundant semantic rereads, 270 ms admission,
and 102 ms start-to-input-event. GREEN: 7 reads, 0 redundant rereads, 165 / 53 ms.

The no-delay long-history fixture uses 1,001 accepted facts (~1 MiB of synthetic
message text). It compares the compatibility path that discards append receipts
and uses the old reread with the optimized path, on separately seeded stores.
One run: 304 / 140 ms admission / start-to-input versus 261 / 92 ms. The complete
runtime-suite run: 560 / 235 versus 260 / 117 ms. Timings vary with load; stable
assertions are 8→6 full Trace reads, 2→0 redundant semantic reads, exact durable
ItemList equivalence and exactly one model sample.

## Coverage

- Production App: idle, steer, new Thread; delayed title; rejected admission;
  retained draft, no fabricated bubble or automatic resend.
- Production App: delayed canonical input and delayed RPC/title independently;
  input event renders a bubble and clears only its exact draft without waiting
  for the others; new draft survives old acknowledgement; title failure stays
  visible without failing an accepted message.
- Production ThreadView: pre-input preparation and admitted bubble/header order.
- Core: durable receipt equivalence, unrelated persisted source inclusion,
  caller mutation cannot change storage, delayed publication and uncertain sync.
- Existing complete runtime and domain-journal suites cover queue/retry,
  reconciliation, writer ownership, crash recovery and unknown-outcome fences.

## Preview

Build with:

```sh
node apps/zenx/scripts/build-send-admission-preview.mjs /workspace/shared/send-admission-preview
```

Open the generated `send-admission-preview.html`. It contains the production
ThreadView, Composer, state transitions, styles and translations with explicit
synthetic controls. Hold admission, then Admit or Reject. Also check Active /
steer, light/dark and narrow widths. No Host or model is connected; it does not
claim end-to-end native storage or physical-device timing. Root captures the
final bundle and records its hash alongside browser screenshots.
