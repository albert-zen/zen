# ZenX Triggers

First-party Triggers package distributed with ZenX and installed through the ordinary plugin profile.

## Thread completion notifications

Use the Triggers page to search and select the Thread to watch and the Thread to notify. Choose a prompt, keep **Only attempt one notification** selected for delegated work, and create the watch. The watch stores the resolved Thread identities; renaming a Thread does not redirect it. **Read source result** reads the exact recorded source Turn, and **Open source Thread** opens its original history. The preview is bounded and explicitly marks truncation.

Model callers can use `zenx_triggers_threads` to discover targets. `zenx_triggers_create` accepts full IDs, unique short IDs or exact titles in `threadId` and `watchedThreadId`. Ambiguous targets return candidates in the error without saving anything. On creation `threadId` defaults to the trusted calling Thread and thread watches default to `once: true`. No client message or Turn ID is needed. For example:

```json
{
  "kind": "thread",
  "label": "Review child result",
  "prompt": "Read the source result and continue our task.",
  "watchedThreadId": "Implement tests",
  "once": true,
  "includeLatest": true
}
```

- A completion means a **Turn ended**, with its actual `completed`, `failed` or `interrupted` status included. Waiting for approval or user input is not a completed Turn. Failed/interrupted output is identified as such.
- `includeLatest: true` checks the latest Turn after installing the watch. If it has ended, the same event path notifies immediately; an active Turn is observed until it ends. Live/snapshot races share one occurrence identity. This option applies only when creating a watch; an empty Thread waits for its first completion.
- `once: true` consumes **one notification attempt**, stopping the watch when its audit entry is saved, before sending. It is not an exactly-once delivery promise. History separately shows sending, queued, failed, or unknown. A crash between audit and acknowledgement can lose a notification or leave delivery unknown; no automatic retry occurs. Acknowledged **queued** means the App Server accepted the input, not that the target Agent processed or completed it.
- Thread notifications use the existing App Server queue: idle targets can start, busy targets receive queued input. Existing queue rules apply, including pausing after a failed/interrupted active Turn and explicit queue resume. Disabling a watch does not retract an input already accepted by the App Server.
- Explicit `once: false` watches subsequent Turns until stopped. Existing definitions without `once` retain repeat behavior. Self-watches and reciprocal watches remain supported; repeated relays can keep starting new Turns, so select them deliberately and use **Stop listening** to end them.
- Restart restores saved watch configuration and marks unfinished delivery unknown, but does not query or replay offline completions. Completed events are deduplicated by the existing bounded history and stable target message identity. There is no outbox, retry service, lease, durable coordinator, or offline delivery guarantee.
- Failed/unknown attempts remain visible in history. **Set up again** fills a new editable watch draft; saving it is an explicit new attempt, not an automatic retry. Source results remain in the source Thread's canonical history independently of bounded Trigger history.

Timer, local program, Room mention and named signal behavior remains available through the same plugin. Optional local actions finish as program outcomes instead of sending an Agent notification.
