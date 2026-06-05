# ALB-93 Real Web UI Transport Smoke Transcript

Date: 2026-06-05

Harness:

```text
npm run build
node docs/implementation/alb-93-real-web-ui-smoke.mjs
```

What the harness verifies:

- starts a deterministic local App Server with HTTP/SSE transport,
- serves `web/index.html` and `web/app.js`,
- installs a minimal DOM and EventSource harness,
- imports and executes the real static `web/app.js` entry,
- lets the UI auto-connect in real mode through the `?server=` URL,
- submits `run shell smoke` through the `#composer` form,
- waits for `#timeline` to render `Shell completed` and `web-smoke`,
- closes both local servers and exits.

Observed output:

```json
{
  "transportUrl": "http://127.0.0.1:49970",
  "webUrl": "http://127.0.0.1:49971/web/index.html?server=http%3A%2F%2F127.0.0.1%3A49970",
  "threadId": "smoke-thread-1",
  "connectionStatus": "Real transport | client: connected | stream: connected",
  "timelineText": "trace\nrun.started\n#1 smoke-item-1\ntrace\nturn.started\n#2 smoke-item-2\nuser\nrun shell smoke\n#3 smoke-item-3\ntrace\nmodel.request.started\n#4 smoke-item-4\ntrace\nassistant.message.started\n#5 smoke-item-5\nassistant\nI will run the smoke shell command.\n#7 smoke-item-7\ntrace\nmodel.request.completed\n#8 smoke-item-8\nshell\nShell completed\nWrite-Output web-smoke\nstdout\nweb-smoke\n\n#9 smoke-item-9\ntrace\nmodel.request.started\n#12 smoke-item-12\ntrace\nassistant.message.started\n#13 smoke-item-13\nassistant\nTransport smoke completed with shell output.\n#14 smoke-item-14\ntrace\nmodel.request.completed\n#15 smoke-item-15\ntrace\nturn.completed\n#16 smoke-item-16\ntrace\nrun.completed\n#17 smoke-item-17"
}
```

Evidence boundary:

This is an automated static Web UI entry smoke without a screenshot. It executes the production `web/app.js` module and DOM event handlers in a local harness, so it covers the UI control path that connects, submits a message, and renders timeline rows. It does not validate visual layout pixels.
