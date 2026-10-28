# Board

A conversation-owned information popup, optionally pinned as a narrow rail separate from Browser/Files. A normal first-party plugin owns its current document and separately preserved user field values in the existing versioned namespace. Internal counters reject stale UI clicks and conflicting window edits; model tools need no revision tokens. There is no execution history, scheduler, auto-retry or second model runtime here.

## Agent tools

- `zenx_board_put({document})`: replaces the current document, preserving user-owned values. The owner defaults to the calling Thread. Explicit `{kind:"room",roomId,threadId}` must bind that same calling Thread and a live Room member. IDs are short, meaningful and stable.
- `zenx_board_read({owner?})`: compact semantic title, summary, field/action IDs and bounded values. It never returns HTML or injects board content into model turns. `truncated` is explicit.

A document has `id`, `title`, `summary`, `blocks`, `events`, optional `initialValues` and `html`. Convenience blocks compose freely:

```json
{
  "id": "launch",
  "title": "Launch checklist",
  "summary": "Pick scope, check locally, then optionally send the result.",
  "initialValues": { "scope": "small" },
  "blocks": [
    {
      "id": "note",
      "kind": "note",
      "text": "Your draft is separate from the chat Composer."
    },
    {
      "id": "scope",
      "kind": "field",
      "field": "scope",
      "label": "Scope",
      "input": "select",
      "options": ["small", "full"]
    },
    { "id": "coverage", "kind": "metric", "title": "Checks", "value": "12/14" },
    {
      "id": "progress",
      "kind": "progress",
      "title": "Readiness",
      "value": 12,
      "max": 14
    },
    {
      "id": "send",
      "kind": "action",
      "label": "Send my selection",
      "event": "send"
    }
  ],
  "events": [
    {
      "id": "send",
      "label": "Send selection",
      "actions": [{ "kind": "submit", "text": "I selected {{scope}}." }]
    }
  ]
}
```

Fields support text, textarea, select and checkbox. Notes, metrics, progress, questions/forms and shortcut actions are conveniences, not a UI ceiling.

## Event composition

Events contain ordered `actions`: `set {values}`, `navigate {route}`, `submit {text}`, `script {command,timeoutMs?}`, and `if {field,equals,then,otherwise?}`. Ordinary local UI and navigation never send a model message. `submit` interpolates `{{field}}`; only that explicit action delivers assembled text. A successful return means native admission (or a precisely reported Room delivery state), not model completion. The chat Composer is never read, cleared or modified.

Scripts use the existing Host shell, sandbox, policy and durable Trace—not JavaScript in the renderer or an unguarded HTTP shortcut. Scripts may invoke an API or submit a form without a model request. The first slice intentionally exposes **shell only**, not arbitrary model-control/plugin methods. If the current policy requires an unavailable approval path, it fails closed. The caller must inspect failed or unknown outcomes; nothing is retried automatically.

Only `{{valuesBase64}}` is interpolated into shell commands: it contains UTF-8 JSON of fields encoded as base64. Decode it using the script's chosen language instead of concatenating user values into shell source. Scripts receive no provider secrets. A confirmed terminal result exposes transient `result.exitCode` and bounded `result.output` to later conditions/text composition; pending/running/task receipts stop the combination and never trigger a success message.

## Custom HTML/CSS/JS

`html` is rendered by the existing isolated Plugin UI Host (`sandbox="allow-scripts"`, no same-origin or direct network). Listen for `zenx-plugin-ui:init` and `zenx-plugin-ui:change`. `window.zenxPluginUi.context` contains `{board, values}`. Use:

```js
await zenxPluginUi.commands.execute("draft", { choice: "custom" });
// Requests a Host-owned confirmation before any declared side effects.
await zenxPluginUi.commands.execute("event", { eventId: "send" });
zenxPluginUi.navigation.navigate("/plugins/zenx-rooms/rooms");
```

Custom JS may freely compose text into a field referenced by a declared submit action, manage local interactions, and conditionally invoke declared events. It cannot replace the Host-owned target, command, permissions or event definition. Host commands remain bounded and stale document/draft identities fail explicitly. This is not a claim that arbitrary scripts can bypass the Host security boundary.
