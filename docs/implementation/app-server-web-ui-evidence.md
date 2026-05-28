# App Server and Web UI Evidence

Date: 2026-05-28

## Scope

This implementation round added the first App Server and Web UI layer around
the item-first Zen kernel while keeping policy, protocol, and UI responsibilities
separate.

The intended boundary is:

- Kernel: produces and stores ordered `Item` records.
- App Server: owns thread and turn lifecycle, snapshots, request dispatch, and
  notifications.
- Policy runtime: wraps tool execution and emits approval trace items without
  moving permission decisions into `AgentLoop`.
- Web UI state: projects protocol snapshots and notifications into browser-ready
  timeline rows.
- Static Web UI: demonstrates the fake runtime path in a browser without a
  backend or bundler.

## Public Surface

The public exports in `src/index.ts` now include:

- `AppServer`
- `ThreadManager`
- `ApprovalBroker`
- `PolicyToolRuntime`
- `createWebUiState`
- `applyAppServerNotification`
- App Server protocol types for request, response, notification, thread
  snapshot, turn snapshot, and protocol item data.

The approval runtime exports the tool-facing decision type as
`ToolApprovalDecision` so it does not collide with the protocol-facing
`ApprovalDecision`.

## Demo Path

The static browser entry is:

```text
web/index.html
```

The fake browser App Server in `web/app.js` supports:

- `thread/start`
- `thread/read`
- `turn/start`
- notification subscription
- normal assistant responses
- fake tool execution
- fake approval request and approve/decline resolution

Representative fake transcript:

```text
thread/start
  -> thread/started

turn/start "hello"
  -> turn/started
  -> item/appended run.started
  -> item/appended turn.started
  -> item/appended user.message.completed
  -> item/appended model.request.started
  -> item/appended assistant.message.started
  -> item/appended assistant.message.completed
  -> item/appended model.request.completed
  -> item/appended turn.completed
  -> item/appended run.completed
  -> turn/completed

turn/start "run shell with approval"
  -> tool.call.started
  -> approval.requested
  -> user chooses approve or decline
  -> approval.resolved
  -> tool.result.completed or tool.error
  -> assistant.message.completed
  -> turn/completed
```

## Linear Issues

- ALB-80: Define App Server protocol and snapshots
- ALB-81: Add thread manager around item-first kernel
- ALB-82: Add approval broker and policy ToolRuntime adapter
- ALB-83: Add in-process App Server request/subscription API
- ALB-84: Add Web UI state projection over protocol notifications
- ALB-85: Add static Web UI shell for fake runtime
- ALB-86: Integrate demo path, evidence, and docs

## Commits

```text
5c351d9 feat: add app server protocol
5405937 feat: add thread manager
18c80d7 feat: add approval runtime
5cb137a feat: add web ui state projection
d679373 fix: export app server runtime modules
d2a1cc7 feat: add in-process app server
6d06242 feat: add static web ui shell
```

## Verification

Commands run after the static Web UI integration:

```text
npm run typecheck
  passed

npm test
  passed: 14 files, 67 tests

node --check web/app.js
  passed
```

Additional browser smoke check:

```text
Chrome headless CDP
  opened file:///D:/desktop/zen/web/index.html
  initialized thread-1
  submitted normal, tool, and approval turns
  observed one pending approval control
  clicked Approve
  observed approval resolution, tool result, and final assistant message
  observed status: idle
  observed 0 runtime exceptions
  saved screenshot: docs/implementation/app-server-web-ui-smoke.png
```

The page is a plain static file and can be opened directly from
`web/index.html`.

## Productization Gaps

These are intentionally outside this implementation round:

- Durable thread storage.
- Real transport, such as WebSocket or SSE.
- Real model provider wiring behind App Server.
- Real filesystem, shell, and network tool runners.
- UI-driven approval resolution wired through a long-running server request.
- Multi-thread browser persistence and routing.
- Authentication, workspace isolation, and audit log retention.
