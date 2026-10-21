# Unified references: two layouts and actual model context

Status: **unselected layout prototypes**, not an implemented unified-reference editor or sent-message projection. Both alternatives show all five requested categories in draft and sent states: thread, full message, sub-agent thread, selected text, and file. Production source, serialization, send, retry, queue, Core, and protocol are unchanged by this comparison.

## One consistent instance

The question is `请结合这些引用说明实现边界，不要把指针当作已经读过的内容。`. The displayed order is:

1. Thread `引用体系设计`, ID `synthetic-host-3`.
2. Full message `引用需要保留来源。\n文件和线程默认只提供位置；选中的原文按快照传入。`, message `synthetic-runtime-3` in that thread.
3. Sub-agent thread `检查发送边界`, ID `synthetic-host-7`, created as a real child of target `synthetic-host-1` in the synthetic Host.
4. Exact selection `文件和线程默认只提供位置` from the same message.
5. File `reference-plan.md` in `/tmp/zen-reference-demo`.

These are [the same typed references](reference-context/current/fixture-bundle.json) used in the provider capture. No real conversations, files, credentials, or paid providers are involved. Full-message references use the existing message snapshot type; a dedicated `@message` picker **does not exist yet**. Sub-agent references are Thread identities, not a new runtime category.

## A / B visual contract

- **A, all outside:** the five reference tokens share one context rail outside both the draft composer and sent user bubble. The bubble contains only the question.
- **B, all inline:** all five tokens are atomic-looking objects in the same text flow in draft and sent samples, not a mixture of some inside and some outside. This shows intended ordering, not a functioning rich-text editor.
- Both reuse production `ComposerShell`, `ComposerEditor` (A), `Markdown`, icon family, and theme. `ReferenceToken` is explicitly fixture-only, with the same details/source/close behavior for all categories and remove only in draft. Removing a draft token never changes the fixed captured sent instance or its model request. Clicking source views only a saved synthetic record; it does not include new content or invoke a tool.
- Both use compact 28px desktop pills. Screenshots assert actual hover/fine media and are labeled Linux Chrome desktop-input emulation, not native hardware. The separate touch fallback remains large enough for touch.
- The HTML can be opened with `?layout=external` or `?layout=inline`. It performs no send and makes no network request. Its model-context section separately exposes current actual requests and a clearly marked future proposal.

## Current implementation, not an idealized payload

The executable capture runs production `withReferenceDraft → beginComposerSubmission → parseSkillDraft → referenceMessage → prepareNativeInput → ZenAppServer.sendMessage → AgentRuntime → InMemoryThreadJournal → OpenAiCompatibleModel / OpenAiSubscriptionModel → injected fetch`. It reads back the canonical user item, then records the exact HTTP body at each adapter boundary. The injected HTTP transport returns synthetic SSE. A separate-process global fetch tripwire prevents a real network call. It does not claim to simulate the entire renderer event system or OS-durable JSONL.

- Current `@` picker accepts file/thread only. File validation checks the path, while `thread/read` checks existence; their returned contents are not included.
- File/thread references become name + path/ID/workspace strings in the question text. There is no downstream automatic reference resolver. Their bodies are absent from the first request.
- Full-message and selected-text snapshots preserve exact source IDs and excerpt in the literal `[zenx-quoted-message:v1]` JSON envelope. The model receives that envelope as text, not a special provider reference object.
- The serializer groups the thread/sub-agent/file pointers into `text` and message/selection snapshots into `quotes`. Cross-category order and inline positions are lost. Both A/B currently have the **same actual payload**; the visual B ordering is not falsely claimed to round-trip.
- The controlled capture's tool environment declares only the automatic `wait` tool. It cannot read the referenced file/thread and no tool executes. This is **not** a claim about the user's normal tool catalog.
- The timestamp is fixed synthetic admission time `2026-10-21T02:00:00.000Z`, not wall-clock capture time. `verification.json` identifies the production baseline whose relevant code is unchanged here.

### Concrete captured examples

- [Complete Chat Completions HTTP body](reference-context/current/chat-completions.request.pretty.json)
- [Complete Responses HTTP body](reference-context/current/responses.request.pretty.json)
- [Canonical user-message item](reference-context/current/chat-completions.canonical-user-message.json)
- [Capture assertions/configuration](reference-context/current/verification.json)

Both requests contain a user-context text part followed by this exact canonical reference envelope (JSON shown here is only pretty-printed for reading):

```json
{
  "version": 1,
  "clientId": "synthetic-reference-submission",
  "text": "请结合这些引用说明实现边界，不要把指针当作已经读过的内容。\n\n[Thread reference: \"引用体系设计\"; thread ID: \"synthetic-host-3\"; workspace: \"/tmp/zen-reference-demo\"]\n\n[Thread reference: \"检查发送边界\"; thread ID: \"synthetic-host-7\"; workspace: \"/tmp/zen-reference-demo\"]\n\n[File reference: \"reference-plan.md\"; workspace: \"/tmp/zen-reference-demo\"; relative path: \"reference-plan.md\"]",
  "quotes": [
    {
      "threadId": "synthetic-host-3",
      "id": "synthetic-runtime-3",
      "excerpt": "引用需要保留来源。\n文件和线程默认只提供位置；选中的原文按快照传入。"
    },
    {
      "threadId": "synthetic-host-3",
      "id": "synthetic-runtime-3",
      "excerpt": "文件和线程默认只提供位置"
    }
  ]
}
```

The linked exact request is authoritative if formatting differs. The fixture's source thread and file contain conspicuous sentinel text; assertions prove neither body entered the request. A separate `with-image.*` capture demonstrates actual image attachment bytes, but is **not** part of the five-reference screenshot instance.

## Proposed contract, not implemented

A unified typed identity should distinguish target (`thread`, `message`, `file`) from included content (`pointer` versus explicit `excerpt`). A future ordered document can hold `text` and `reference` parts plus a reference table; A/B become projections of the same document. Switching layouts must not read additional source content. The interactive HTML labels its example `PROPOSED_ONLY_NOT_SENT`.

This needs a deliberate canonical round-trip contract before production implementation, not a new hidden frontend store or inference from arbitrary user text. True inline editing also needs cursor movement, atomic deletion, IME, paste, undo, and accessibility handling. Neither a full-content snapshot nor automatic whole-thread/file dereferencing is assumed. A still needs recoverable typed sent references; old strings cannot safely be reparsed as reference objects.

## References and recommendation

Tencent's [official WorkBuddy conversation documentation](https://www.codebuddy.cn/docs/workbuddy/Conversation) documents selecting text, Copy/Add to conversation, full-text hover, and multiple references in one message. Its [actual annotation screenshot](https://download.codebuddy.cn/web/docs/aafbbf51beede9ed92e891325729f1e61074e0a4/docs/static/conversation-quote-annotation.tjsvmGP9.png) shows annotation beside selected response text, not proof of arbitrary inline composer placement. B follows the requested direction, not an invented claim about WorkBuddy internals. A similarly follows the requested Codex-style direction; current official sources did not establish the exact outside-bubble layout in this check.

For questions about a whole set of materials, A makes the separation between instruction and supporting context easiest to scan. For interleaved, locally targeted commentary, B is more expressive. UI coherence takes priority over ease of implementation; neither is selected as the default.

## Reproduce / verify

```sh
node --import tsx apps/zenx/scripts/capture-reference-context.mjs /tmp/zenx-reference-context
node --test apps/zenx/test/reference-context-capture.test.mjs
node apps/zenx/scripts/build-quote-layout-preview.mjs /tmp/zenx-reference-layout
node apps/zenx/scripts/capture-quote-layout-preview.mjs /tmp/zenx-reference-layout
```

The context regression compares both generated HTTP requests and canonical user items against the committed examples. CI runs the capture before visual capture and retains all artifacts, followed by the unchanged full project checks. The browser capture verifies five categories, placement in both stages, compact desktop geometry, no horizontal overflow, common details/source controls, exact multi-line excerpts, and draft-only removal. Screenshots must be inspected and embedded in PR456 at the exact source revision before visual acceptance; artifact generation alone is not acceptance.
