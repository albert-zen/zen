# Native asynchronous user questions: implementation proposal

Status: backend draft in progress; UI and production rollout are not complete. Base: pending-steer recall integration
`3d8f9cd24109f7fbf7abaca32c1bae4ade130f80` (#626 candidate, including the integrated naming, existence-read performance and Send-focus fixes).
This is a dependent native slice, not another fixture or a replacement runtime.

## Reference and current evidence

The source/screenshot research is preserved separately in
[draft experiment #625](https://github.com/albert-zen/zen/pull/625).
Codex main was rechecked on 2026-11-02 at
`3026a8e54e0f48c4d8074cd700f35b0697abc329`:
[asynchronous handler](https://github.com/openai/codex/blob/3026a8e54e0f48c4d8074cd700f35b0697abc329/codex-rs/core/src/tools/handlers/request_user_input_async.rs)
publishes questions and returns immediately; replies arrive as user messages.
The real desktop screenshots support the question controls and input-required
capsule, but desktop source remains unavailable. CLI/TUI is not desktop UI code.

The real Zen runtime probe established that semantic call/result publication is
possible today, ordinary client IDs deduplicate one intent, but two different
client IDs still admit two answers to the same apparent question. Text equality
and model sample selection cannot supply the missing request binding.

The recall integration now provides the needed input boundary:
`user_message_queued` is pending control in durable Trace; `pendingSteerMessages`
and `pendingQueuedMessages` reconstruct effective pending inputs. The existing
mutation-locked claim appends a real semantic `user_message`; recall can win
before that claim, not after. No remote inference acknowledgement is inferred.

## 1. Publish a real semantic request

Add `AskUserQuestionToolRuntime` and bounded content validation, registered in
the existing Host builtin catalog as `ask_user_question` only when the trusted
Host startup option `experimentalUserQuestions` is explicitly `true` (default
`false`). It has no external
side effect, secret, listener, Promise retained across turns, or new storage.

- Input: authored question IDs, full prompt, optional stable-ID options,
  optional multiselect, and deterministic answer template. Free text is always
  allowed; no default selection sends itself.
- Runtime-owned identity: `(invocation.threadId, canonicalToolCallId)`.
  Arguments cannot override either value.
- Output: bounded versioned JSON in the **actual model-visible output text**,
  containing the same identity and publication outcome. It is not merely
  `structuredContent`, which does not automatically survive semantic conversion.
- A question exists only after the matching successful result is committed.
  Read its immutable spec from the real semantic call, and the identity/receipt
  from the matching semantic result. Failed/unknown calls do not publish.
- Keep this tool directly visible in `direct`, `code` and `both` presentations,
  alongside the existing direct-only `compact_context`. Exclude it from the
  nested code catalog so a Trace-only nested call cannot publish invisible
  questions. Reject a program-audience invocation defensively.
- Only new local calls beyond the existing fork/import native history boundary
  activate. Matching envelope Thread/call identity is also required. Do not use
  missing Trace.origin as proof of locality, and do not parse arbitrary user text.

Stable model tool description:

> Ask the user one or more questions with optional choices and free-text answers.
> This publishes a question card and returns immediately; it does not wait for an
> answer. Answers or explicit cancellation arrive later as ordinary user messages
> linked to this request. Continue independent work, or finish your turn if the
> next step requires the answer. Do not poll or treat defaults as user approval.
> Do not request secrets or use this tool instead of a permission approval flow.

The Host owns registration; model arguments and native client requests cannot
enable it. No model-facing answer tool is exposed.

## 2. One explicit native answer port

Add `zen/thread/questions/respond` with a strict native wire schema:

```ts
type QuestionResponse = {
  threadId: string;
  questionCallItemId: string;
  clientUserMessageId: string;
  clientTimezone?: string;
} & ({ outcome: "answer"; answers: QuestionAnswer[] } | { outcome: "cancel" });
```

No caller-supplied `role`, `sender`, message text, result Item ID, provenance,
delivery state or creation timestamp is accepted. The existing authenticated
native/Host connection owns caller scope. The Host checks the exact Thread and
local committed request; a syntactic ID is not authority. The endpoint does not
get added to model tools or generic Fleet passthrough.

`ZenAppServer.respondToUserQuestion` reuses ordinary **soft send**: idle starts
normally; active input is recallable steer. It does not force idle input through
batch-next/resumeQueue. That rejected shortcut changes competition semantics and
would put the answer outside atomic steer recall.

Use a narrowly shared private ordinary-send dispatcher, preserving the current
bounded start/steer race retry behavior. Public ordinary `sendMessage` calls it
without question data; the new native question method passes a parsed candidate.
Render a candidate outside admission if useful, but do not trust it until the
following native locked checks. No public generic metadata option is added.

Add one dedicated `#validateQuestionReplyUnlocked` helper, not a generic guard
framework. It reads the current Thread's actual semantic publication and native
input projection and validates:

1. Thread is live/unarchived and journal recovery is safe; request is an accepted
   local call/result pair, and submitted answers belong to its immutable schema.
2. Host-generated ordinary message text exactly matches the normalized answer or
   explicit cancellation. The client never supplies the canonical body/provenance.
3. Same client and exact request/outcome/normalized answer returns its original
   receipt; any change or collision with an unrelated input operation conflicts.
   Recalled/canceled old identities cannot revive themselves.
4. Different clients cannot admit another response while this request has an
   effective pending response or claimed semantic user answer. The exact pending
   input's own existing claim is allowed; that is not a second human admission.

Call the check at the actual existing locked write boundary, not only at an
outside snapshot:

- **Idle**: use the existing `#launchTurn` path and initial user message. Pass the
  Host-validated binding only through its private internal initial-input argument.
  Preflight under its admission lock, then revalidate immediately before the
  actual initial `user_message` commit under the existing runtime commit lock.
  The ordinary start receipt remains gated by `initialInputCommitted`/`ready`.
- **Active**: extract only a private variant of existing `stageSteerMessage` that
  can carry the candidate. In its same Thread mutation lock, validate the request
  and append the existing steer `user_message_queued` with its binding. The queue
  fact is durable Trace; its future ordinary user-message claim retains semantics.
- **Initial-commit window**: another Ask response seeing an active Turn whose
  initial input has not committed waits for that exact `active.ready` **outside**
  the mutation lock, then re-enters native validation. The private staged write
  checks this condition under lock too, returning a wait plan rather than nesting
  a public locking call. This closes the gap between first-answer launch and its
  semantic commit without inventing a persistent reservation or ActiveTurn ledger.
  A failed/unknown initial commit propagates; it is not blindly replayed.

The existing claim path remains authoritative for receipt versus irreversible
model input. Return native Turn/admission identity plus a canonical question read
projection. Unknown commit/transport outcomes cause read-only reconciliation
using the original client identity, never automatic resend with a fresh ID.
A rejection from active.ready is propagated without fallback, client-ID replacement
or blind start retry. Only the existing definitive pre-admission thread-busy/
turn-not-running races are retryable. No new queue mode, resume scheduling, durable
reservation, or generic admission middleware is introduced.

## 3. Keep association in the actual three durable domains

`questionReply` is a strict, versioned semantic reference: Thread + request call
Item + answer/cancel outcome + normalized selected option IDs/free text. It is
not a control-state field. The generated message body remains the model-readable
human response; provenance preserves which immutable question/choices it answers.

- Pending input: extend the existing queued-user-input fact's payload. It remains
  a Trace control observation; it does **not** become an ItemList variant.
- Claimed input: preserve the validated association through `InitialInputMessage`
  and every existing queue/steer claim into the real `ContextItem` user-message
  provenance. Extend the strict semantic metadata decoder, legacy conversion and
  compatibility projection together. Adding only a legacy `CanonicalItem` field
  would be insufficient and is explicitly not the proposed implementation.
- Current question read state is derived, not persisted. No fourth store,
  question database, editable historical snapshot or repair state machine.

Audit all existing claim paths: ordinary idle initial input, normal next-sample
steer and held steer carried into an explicitly authorized successor. Preserve
association defensively in existing next-Turn batch/explicit queue promotion
conversions too; this feature does not introduce question-specific queued modes.
Reject generic queue editing of a question-associated response: it would let text
diverge from validated choices. Users can recall/cancel the pending input and
explicitly answer again with a new intent. Generic queue cancellation and the
existing atomic recall release the question reservation; both preserve old IDs.

## 4. Rebuild and UI boundary

The native projector consumes actual `ContextItem[]` plus the existing native
control read projection. Its states are open, answer/cancel pending, answered,
canceled, or unavailable. A receipt is not answered. The existing irreversible
user-message claim is answered, not a claim that remote inference ran exactly
once. Missing/inconsistent authority is unavailable, not automatically repaired.

Return this read model from `zen/thread/read` and after response admission.
For live UI, emit a bounded native read-projection update only after relevant
committed publication/input/recall facts, never for text deltas or arbitrary tools.
The event is disposable and rebuildable; it is not another persistent event log.

The separate information panel owns per-request draft, choices, free text and
explicit send/cancel. Closing it does not cancel; no main-composer draft or queue
edit is taken over. Whole-batch recall retains full question association and remains
one atomic operation: a failed or stale target cannot partially restore the batch.
The confirmed UI rule is “return to the originating input”: question answers return
to their original question cards with choices/free-text drafts intact, while
ordinary messages return to their original composer. This backend slice preserves
the binding needed by that subsequent UI integration; it does not implement the
restoration UI. Unknown reply UI is read-only pending reconciliation; stale replies
cannot clear another draft.

Only an accepted local publication adds the new one-time automatic Project/Recent
activity timestamp. Reply-state changes do not bump tools generically. Existing
human-message ordering remains separate; pinned membership/order stays manual.
Ordinary model completion does not clear unanswered questions. No model withdrawal
operation is included in this slice.

Native `ThreadSummary.userQuestionSummary` carries `{openCount, latestPublishedAt?}`.
It counts request groups in exact `open` state, not authored subquestions, pending
responses or unavailable cards. Zero open is not proof an answer was model-visible;
attention pages still contain pending/unavailable states. The timestamp is the max
original successful local result time across all published requests, including
closed ones. Answer/claim/recall never re-date it. A real explicit Answer or Cancel
is an ordinary human input and retains its original receipt promotion; later
Question status changes do not promote again. The existing `recentActivityAt` is
the max of ordinary human/final-answer recency and accepted local publication time,
so Recent and default Project lists share the same sorter and stable Thread-ID tie.
New normal summaries provide zero when empty; legacy/unavailable summaries can
omit this projection. Imported/forked old questions do not count or promote.

## 5. Performance, transport and rollout boundary

The Thread owns a disposable index, populated while existing decode/append work
already visits each source record. No-Ask snapshots do not scan historical arrays
or parse JSON. Ordinary messages/tools/status do not reparse old publications.
Relevant question results, bound responses and native withdrawal/claim facts
invalidate it; a cold rebuild from actual persisted sources must equal the live
projection. The two summary scalars are computed inside that same existing indexing
pass, not by cloning schemas or rescanning history on summary reads. Call-only
bookkeeping does not dirty accepted attention before its result. Compilation repair
can append a missing call after its result; the existing local candidate index
retains result-seen evidence so that repaired call invalidates the projection even
after an earlier incomplete read. Existing native
commits refresh summaries before attention invalidation; no additional per-token
or compiler-item summary refresh is introduced. This cache is not a fourth authority.

The native transport bounds the snapshot to a page of pending/current
attention cards, excluding historical answered schemas. A page budget is not a
feature limit: explicit continuation and exact request reads keep every pending
question accessible. Live updates identify one request or invalidate attention;
they do not rebroadcast all historical schemas. Exact Thread/request/original
client-ID readback distinguishes current facts from an unconfirmed write.
Absence from a page never means answered, and a missing fact while admission may
still be in flight remains unknown. Explicit retry reuses the original intent
and payload; no automatic fresh client ID is generated.

`ThreadSnapshot.userQuestions` is at most 32 attention cards with
`userQuestionsPage.totalPending` and optional `nextAfter`. Continue through
`zen/thread/questions/list {threadId, afterQuestionCallItemId?}`; stable local
publication identity is the cursor, including after it has been answered. No
durable cursor is stored. Paging is not an atomic snapshot: a delayed result for
an earlier call or a recalled old answer can appear before an existing cursor.
Clients must discard a previous page traversal and refresh the first page on
attention invalidation (or reconcile an exact request), rather than claiming a
cross-change concatenation is complete. `zen/thread/questions/read {threadId,
questionCallItemId, clientUserMessageId}` is read-only and returns one request
plus the exact original intent's pending/claimed/withdrawn/conflict/not-found/
unknown receipt projection. It does not start/resume a Turn. Old withdrawn
intent and newer accepted answer remain distinguishable.

`user_question_attention_invalidated` is a bounded native live event containing
only Thread identity. It is emitted after relevant durable commits, never from
ordinary token/status/tool events; the recovery projection coalesces its transient
tail. Clients refresh a page or an exact request rather than parsing full history.
CAS has no new schema mapping; the current renderer ignores the event until its
separate Question UI integration. Snapshot question cards are captured after the
last asynchronous metadata read, at the same synchronous boundary as source Items.

The Host-owned `experimentalUserQuestions` option defaults off. Changes use the
existing Host pending-restart mechanism, not a dynamic client capability or new
permission system; explicit `false` and omission are equivalent. Disabling new
publication does not gate native list/read/respond: previously published local
questions remain recoverable and answerable. The native capability advertises
protocol support, not that publication is enabled or a particular client has UI.
Synthetic acceptance fixtures opt in explicitly. Desktop's shared Host is not
globally enabled, since that would also expose the tool to unsupported Room/PAW
paths. CLI, Rooms and external clients remain off unless the Host owner explicitly
selects an experimental deployment; a supported Desktop-default rollout needs a
separate reviewed product binding and linked answer UI, not client self-report.
Hidden child-thread questions require visible
attention without undoing manual hiding or changing pinned membership/order.
An Ask in the selected Thread may reveal its card but must not steal keyboard
focus; other Threads only gain attention/automatic ordering, never forced
navigation. Closing a card does not cancel. UI recovery, pagination and hidden
child/pinned behavior remain the next product integration boundary.

## 6. Intended source and acceptance boundary

- `src/user-question.ts`: bounded semantic content.
- `src/user-question-state.ts`, `src/thread.ts`: real-fact read projection and disposable index.
- `src/user-question-tool.ts`, `apps/cli/src/host.ts`,
  `src/tool-presentation.ts`: actual builtin and direct-only exposure.
- `src/item.ts`, `src/item-list.ts`, `src/item-list-legacy.ts`, `src/runtime.ts`:
  strict association validation and lossless input-to-semantic preservation.
- `src/app-server.ts`: native atomic response admission, existing claim paths,
  question snapshot/update and generic-edit guard.
- `src/protocol/native/{wire,connection,recovery}.ts`: strict new native method
  and rebuildable UI projection transport. No CAS schema extension.
- Focused real Host/DomainJournal/native tests first; UI/automatic-sidebar
  integration is a subsequent cooperating slice, not guessed complete here.

Required tests: actual model call/result publication; model sees normal human
answer; two clients racing same question; same-ID different payload; pending
receipt vs claim; atomic recall and new answer; late old-ID retry; claim wins
recall; idle/active/held-successor claim paths; initial-commit competition; cold reload; fork/import; archive/delete; unrelated
Thread/forged metadata; generic queue-edit rejection; native method validation;
code-only presentation still exposes direct Ask and rejects nested Ask; failed
semantic publication never shows a card or adds recency. Existing recall tests
must remain green; no pre-existing branch is modified.
