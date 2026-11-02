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


## Fourth case: two lost replies, followed by explicit read-only recovery

[Run 41401906539](https://github.com/albert-zen/zen/actions/runs/41401906539), job125135346337, exact same product279f, **passed** the additional required recovery case in a fresh owned App.

The actual recall handler durably succeeded, but its reply was replaced only at the diagnostic transport boundary with the generic error `SYNTHETIC transport reply unavailable`. The product legitimately attempts an automatic read-only reconciliation. To exercise its stable unknown state, the first **actual completed** read response was also lost with that same generic transport error. Genuine target-thread notifications remained held. This is explicitly a **two-response-loss scenario**: a single lost recall ACK followed by successful automatic read-only reconciliation is allowed to recover normally and is not required to remain unknown.

Verified sequence:

1. The real unknown-state warning appeared. The current draft was unchanged, with no automatic resend and no repeated recall mutation.
2. Native editing replaced the selected current draft with that draft plus additional text, using the actual editor's native Select All action, read-only selection-range verification and native text insertion; no JavaScript value/caret assignment.
3. The user-facing Check button performed the next actual read-only request and recovered the real receipt. Both recalled messages merged once, in order, before the latest draft.
4. **Before releasing the held real notification**, the known-success batch had no enabled Recall action and no actionable legacy queue row for its target IDs. Recorded checkpoint: notifications still held=true, held count=1, recall button actionable=false, legacy actionable rows=0.
5. Releasing the real receipt notification did not duplicate the recovered content. The exact actual Turn completed normally.

Independent read-only reopening found two staged facts, exactly one recall control fact, only one canonical user message, complete Trace and zero compaction facts/attempts. Withdrawn nonces were absent from semantic history and the sole actual model request (`[true,false,false]`). Exactly one recall RPC and the original three send RPCs occurred. The log's three completed read entries are the failed automatic-read reply, successful user Check, and final verification projection read—not three recovery attempts.

The [first attempt 41401044397](https://github.com/albert-zen/zen/actions/runs/41401044397) reached the real unknown state and passed no-auto-restore/resend checks, then failed because the fixture's macOS end-of-document key chord did not move the caret to the asserted end position. It never reached Check and is **not** counted as passed. The repeat changed only the native editing fixture to the already verified native Select All path; product code and all behavioral/storage gates remained unchanged.

This closes the four explicitly assigned native cases within their stated fake-provider/text-input scope. It does not establish general network reliability, real-provider latency or unsupported-input coverage. Repository-wide CI and merge approval remain separate.


### Visual follow-up found a real remaining UI defect

After the fourth case's behavioral/storage assertions passed, full-page PNG inspection found that the recovered composer was correct and the batch was no longer actionable, **but the old “Recall outcome is unconfirmed” warning remained visible after successful read-only recovery**. Therefore the functional pass above must not be read as complete UI acceptance.

The observed recovered image SHA-256 is `313a4eed87fea7d87e68bc8870bdd66224692bc1aa0f7291b52fdba5d0dba9f0`, from [artifact-only image readback 41402842948](https://github.com/albert-zen/zen/actions/runs/41402842948), exact279f. The source success transition spreads the prior attempt, including its error. The author is correcting that state transition and adding regression coverage; the native case now additionally requires the unknown warning to disappear on authoritative recovery success while the real notification remains held. Only this fourth case needs repeating on the corrected source. This visible defect and the earlier functional pass are both retained.
