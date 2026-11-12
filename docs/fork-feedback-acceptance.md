# Fork feedback, final-message fidelity, and initial publication

Synthetic acceptance only. No private conversations, screenshots, Trace files,
credentials, workspace contents, Provider calls, or tool execution are included.

## Behavior and durability

- Fork immediately shows a spinner, disabled duplicate-click guard, and localized
  tooltip / accessible name explaining that the Thread is being copied.
- An exact final-message cut retains the source's already-observed successful
  completion receipt and timestamp when only usage observations intervene.
  Intermediate or active cuts remain inert snapshots; no source execution moves.
- Exact semantic text, agentic reset exclusions, sample-local selection, and
  nested media provenance survive identity remapping and cold/nested forks.
  Source reference ownership is not transferred.
- Initial creation writes the same checksummed Trace JSONL frames in bounded
  groups (256 frames / approximately 1 MiB; an oversized frame remains intact).
  The existing writer queue, file/directory durability checks, and publication
  fence remain authoritative. Ordinary append behavior is unchanged.
- A failed unpublished copy is not a discoverable or compilable Thread after
  restart. Neither `create` nor initial `append` can overwrite its identity.
  Existing relational validation still runs with an exact frozen ItemList.
- Unknown transport outcomes do not automatically retry creation or guess a new
  destination. The original view/error remain, and summaries refresh read-only.
  Creation has no protocol idempotency key: lost-ACK retry is **not** claimed
  resolved. A deliberate fresh action after a confirmed unpublished failure is
  covered separately for Fork and Sidechat; no new retry policy is introduced.

## Measured critical path

Command (local Linux x64, Node 24.22.1, synthetic 1 KiB tool results):

```sh
node --import tsx scripts/measure-fork-critical-path.ts
node --import tsx scripts/measure-fork-critical-path.ts --side-chat
```

| Canonical Items | Serial exact-message Fork | Final batched exact-message Fork |
| --------------: | ------------------------: | -------------------------------: |
|              50 |                    187 ms |                            41 ms |
|             500 |                  1,310 ms |                            96 ms |
|           2,000 |                  4,010 ms |                           301 ms |

At 2,000 Items the serial path spent 3,703 ms in 3,998 individual Trace writes;
the final batched path spent 112 ms in 16 batch calls. Initial journal creation
fell from 3,927 ms to 246 ms, retaining canonical relational validation. The
batched Sidechat path measured 26 / 90 / 290 ms for 50 / 500 / 2,000 Items.
Timing varies with filesystem load; these are actual local measurements, not a
claim about the user's Mac, IPC latency, DOM paint, or end-to-end first Send.
No workspace files are copied by the same-directory fork operation.

## Tests and visual boundary

Regression tests cover observed final completion, exact-prefix exclusion,
intermediate/active/stream-only cuts, cold/nested continuation, compaction reset
and media address preservation, batch ordering/bounds/cold reads, blocked fsync,
torn frames, later-batch failure, unsafe initial retry, and unchanged source
history. App tests cover exact target, duplicate click, newer navigation,
visible errors, and read-only refresh after an uncertain reply.

Production-component browser fixture:

```sh
node apps/zenx/scripts/build-fork-feedback-preview.mjs .fork-feedback-preview
node apps/zenx/scripts/capture-fork-feedback-preview.mjs .fork-feedback-preview
```

The fixture builds successfully and contains synthetic content only. Browser
capture remains an acceptance gate: this executor's Chromium failed before
rendering with a denied singleton socket; escalation failed during sandbox
setup. No screenshot or native desktop visual pass is claimed by these tests.
