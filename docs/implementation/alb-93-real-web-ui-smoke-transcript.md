# ALB-93 Real Web UI Transport Smoke Transcript

Date: 2026-06-04

Harness:

```text
npm run build
node docs/implementation/alb-93-real-web-ui-smoke.mjs
```

The harness served:

```text
App Server transport: http://127.0.0.1:61312
Static Web UI: http://127.0.0.1:61313/web/index.html?server=http%3A%2F%2F127.0.0.1%3A61312
```

Smoke command:

```text
node --input-type=module -e "import { HttpAppServerClient, WebUiClient } from './dist/index.js'; ..."
```

Observed Web UI client state after connecting to the real HTTP/SSE transport,
submitting `run shell smoke`, and waiting for streamed notifications:

```json
{
  "connection": {
    "mode": "real",
    "status": "connected"
  },
  "thread": {
    "id": "smoke-thread-1",
    "status": "idle",
    "turns": [
      {
        "id": "smoke-turn-1",
        "runId": "smoke-run-1",
        "status": "completed",
        "itemIds": [
          "smoke-item-1",
          "smoke-item-2",
          "smoke-item-3",
          "smoke-item-4",
          "smoke-item-5",
          "smoke-item-6",
          "smoke-item-7",
          "smoke-item-8",
          "smoke-item-9",
          "smoke-item-10",
          "smoke-item-11",
          "smoke-item-12",
          "smoke-item-13",
          "smoke-item-14",
          "smoke-item-15",
          "smoke-item-16",
          "smoke-item-17"
        ]
      }
    ]
  },
  "rows": [
    { "type": "trace", "event": "run.started" },
    { "type": "trace", "event": "turn.started" },
    { "type": "user", "content": "run shell smoke" },
    { "type": "trace", "event": "model.request.started" },
    { "type": "trace", "event": "assistant.message.started" },
    {
      "type": "assistant",
      "content": "I will run the smoke shell command."
    },
    { "type": "trace", "event": "model.request.completed" },
    {
      "type": "tool-call",
      "toolName": "shell",
      "input": { "command": "Write-Output web-smoke" }
    },
    { "type": "trace", "event": "tool.output.delta" },
    {
      "type": "tool-result",
      "toolName": "shell",
      "content": {
        "exitCode": 0,
        "stdout": "web-smoke\n",
        "stderr": ""
      }
    },
    { "type": "trace", "event": "model.request.started" },
    { "type": "trace", "event": "assistant.message.started" },
    {
      "type": "assistant",
      "content": "Transport smoke completed with shell output."
    },
    { "type": "trace", "event": "model.request.completed" },
    { "type": "trace", "event": "turn.completed" },
    { "type": "trace", "event": "run.completed" }
  ]
}
```

Browser automation note:

```text
The in-app Browser setup timed out twice while connecting to the local page.
Chrome headless was available but did not emit a screenshot file in this
workspace. This transcript is the required smoke artifact for the real Web UI
transport path.
```
