# Native whole-batch steer recall evidence — 2026-11-02

Exact product source: `279f84ff35c68979a55f35c5322c941235dff7be` (PR616). [Hosted native run 41399317890](https://github.com/albert-zen/zen/actions/runs/41399317890) passed all three independent private full-App cases.

## Scope and truthful boundaries

Each case used the complete production Electron App, actual native mouse/text input, the actual running-mode Steer button, two real staged admissions, and the actual whole-batch Recall control. Production DomainThreadJournal, Trace and semantic ItemList stores were used and independently reopened read-only after normal owned-Host shutdown.

Only a declared test-only module was added to the owned synthetic Host: it wraps the same bundled FakeModel stream, records bounded synthetic nonce-presence booleans and pauses before delegating to the original generator. It does not synthesize model events, canonical events, admission replies, recall receipts, conflicts or UI rows. The launcher checks exact product HEAD, exact sole diagnostic Host insertion and source/bundle hashes. No user instance, credentials, remote debugging port, paid model or compaction was used.

This is **functional correctness evidence, not a performance benchmark**. The navigation destination is an **unsent new-thread draft**, not a second persisted Thread. Lost-recall-ACK read-recovery, expanded skills/audio and real-provider behavior are not claimed covered by these three cases.

## Verified cases

| Case | Actual behavior | Independent persisted result |
|---|---|---|
| Recall wins — job125127453624 | Initial real provider request held; two real steer messages staged; a newer draft typed; whole batch recalled and merged in original order before that newer draft. Pending shelf and legacy queue rows disappear. | Two staged facts, one immutable recall fact, only the initial canonical user message. Recalled nonces absent from semantic history and every actual model request. |
| Claim wins — job125127453700 | Release initial request; actual Host claims both staged messages into the same Turn's next request while genuine claim notifications are held. Stale UI Recall receives real `steer_recall_conflict`; visible whole-batch conflict text is asserted and current draft is unchanged. | Two staged facts, three canonical user messages, zero recall facts; no partial removal. |
| Navigation — job125127453265 | Real recall commits while its actual reply and target notifications are held. Native navigation creates a different unsent draft. Releasing the late reply neither navigates/resumes the original Thread nor overwrites the other draft. Returning deliberately exposes recovery; only explicit two-click confirmation merges the batch into the original newer draft. | Same recall-wins durable result; manual recovery does not resend anything. |

For recall-wins and navigation, the only actual model-request nonce matrix was `[initial=true, steer1=false, steer2=false]`. For claim-wins, it was followed by `[true,true,true]`, with exact matching Thread and Turn identities. Every recorded request finished normally, every case waited for the exact actual normal Turn terminal event, all gates were released, and exactly three native send requests occurred: no automatic resend.

All cases had complete Trace and **zero compaction facts or attempts**. Recall-control and queued-control fact IDs were absent from semantic ItemList. Each recalled receipt ID and entire target/revision set matched the actual RPC result and independent persisted fact.

## Retained initial failure

[Initial two-case run 41398526913](https://github.com/albert-zen/zen/actions/runs/41398526913), source `c5b387c306d6015e3034cdacbf199edc4b8f70c2`, failed **before the App was launched** at eight test-fixture TypeScript errors. No native functional result was claimed. The author corrected only fixture typings in279f; the diagnostic retained its typecheck gate and then ran all three cases above. This failure is not rewritten as a passing run.

Full-page screenshots and exact diagnostic measurements/source manifests are attached to the successful native run. Repository-wide CI, independent product review and merge approval remain separate.
