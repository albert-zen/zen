# Bound user MCP: first functional Host slice

## What is implemented

`apps/zenx/src/main/user-mcp.ts` embeds an official MCP SDK stdio server into an
already-owned Zen Host. The caller supplies the actual AppServer,
ZenXCapabilityService, the exact AgentRuntime ToolEnvironment, BoardHostService,
exact Thread/Room owner and a mandatory
one-way connection lifetime signal. The adapter never opens a data directory,
starts another AppServer or stores connection configuration.

This is a functional **Host embedding API**, not a shipped desktop launcher or an
installed user harness configuration. The private fixture is the runnable
integration entry point; it is not presented as production registration.

The MCP tool inventory is projected from currently exposed native tools:

- `zenx_threads_read`: bounded public canonical history for the bound Thread.
- `zenx_board_read`: semantic or explicit full Board document read, with optional
  authored `instanceKey` for independent Boards. Omit it for the legacy default.
- `zenx_board_put`: replacement against an immutable complete-document snapshot,
  or a known-absence snapshot. Native Board CAS preserves unsent user fields.
- `zenx_self_control_sidebar_read`: the exact bound Thread/Room sidebar state.
- `zenx_self_control_sidebar_update`: immutable-snapshot CAS on that state.

Board writes take their exact owner/address/revision only from an immutable full
read or known-absence snapshot; `instanceKey` cannot be supplied to a write or
substituted through `document.id`. Independent Boards and the legacy default stay
isolated. Board UI events, scripts, model sending, thread management, credentials
and device access are not exposed.

## Authority and lifetime

The MCP client cannot supply a Thread ID, owner, device or native revision.
Host-owned references select the fixed owner. Input/output contracts reuse the
existing model-tool facade, including complete-document snapshot provenance,
Browser-reference checks and native permission guards. Connection-qualified
snapshot strings prevent old `rN` references from aliasing a new connection's
snapshots.

The adapter prepares, admits and executes in the **same ToolEnvironment already
used by the Host AgentRuntime**, so remembered approve/deny decisions, prepared
generation leases, resource ownership, tasks and Trace are shared. Inventory is
read from that actual ToolEnvironment, not a possibly newer Catalog publication.
A private in-process symbol at the existing ZenXHostToolBundle selects native
argument projection after the existing model facade has bound the MCP owner;
the symbol cannot be supplied in JSON/tool arguments or cross IPC, and is not a
human UI trust flag or an approval grant.

An optional trusted ApprovalHandler can route through the existing
CodexConnection.requestApproval async protocol and UI. No synthetic human
approval, second approval registry or Turn is created. The real private Host test
checks accepted, declined and revoked-during-prompt responses through that exact
protocol. Without such a handler, sandboxed/approval-required calls still fail
closed. Immediately before launch, the existing AppServer `dispatchHostTool`
mutation fence checks current Thread permissions and archival state. Domain
operations retain their own live owner checks and CAS.

`AppServerManager.hostToolApprovalHandler()` now binds a native Host tool request
to the current process and Desktop protocol-client generation. It uses the same
pending approval map, renderer request/resolved events and existing UI response
path as ordinary tools. Abort, reconnect and Host replacement retire the old
request/handler; it never creates a synthetic canonical Turn or tool Item.

The production connect-only stdio launcher and main/child MCP IPC path are now wired.
Run `npm run user:mcp --workspace @zen/zenx -- --descriptor /absolute/path/to/existing/runtime/connection.json --thread THREAD_ID [--room ROOM_ID]`, or, after a repository build, run `node apps/zenx/out/main/user-mcp-stdio-cli.js` with the same arguments. These are developer/source and repository-built entries; the installed packaged-app invocation and real-user client registration are unverified. The descriptor and bearer file use existing restrictive-permission readers. The launcher never scans home, opens a journal, starts a Host, creates credentials, edits client configuration or registers a harness.

The fixed-owner native `zen/mcp/bind` / `zen/mcp/message` tunnel uses the already authenticated loopback ZAS endpoint. Core injects a narrow product callback rather than importing Desktop state. The existing child embeds the official SDK Server and exact existing AgentRuntime ToolEnvironment. Typed IPC checks the immutable owner against main's existing BoardHostService; Room membership observation retires a binding one-way. Approval IPC captures AppServerManager's existing generation-bound normal renderer approval handler at binding time. Cancellation and owner/generation loss retire the normal pending approval request, without another approval or policy registry.

`apps/zenx/test/user-mcp-live-host.test.ts` explicitly boots the real manager/child before launching the official SDK Client's stdio subprocess. It verifies canonical history, known absence, Board CAS/write/readback/stale conflict, unchanged child PID and unchanged ItemList; normal asynchronous Desktop approval events and responses; approval decline; same-name capability generation retirement during approval; and Room loss while waiting for approval, with no intervening MCP read and no revival on rejoin. The same two acceptance tests also pass with `ZEN_MCP_TEST_USE_BUILT=1`, which launches both the repository-built stdio entry and repository-built actual AppServer child. These are private real process-split tests, not installed packaged Electron pixel evidence.

Thread permission/archive/delete events, Room membership loss, any capability
Catalog publication and the supplied connection lifetime retire the binding.
Re-enable/rejoin never revives it. A trusted Host launcher must explicitly create
a new binding. No automatic reconnect, command retry or mutation replay occurs.
Unknown tool names return the SDK JSON-RPC `-32602` protocol error, as required by
the [official MCP error contract](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#error-handling).
Known-tool validation and domain/permission failures remain `isError:true` tool results.
CAS conflicts are successful protocol results with `applied:false`; the caller
must read and deliberately merge. A failed reply after write dispatch is labeled
possibly unconfirmed, never as permission to retry.

Only disposable protocol handlers, references and cancellation observations are
added. Existing ItemList, product storage and Trace owners remain unchanged.

## Reproduce

Install the repository's normal dependencies, then prepare first-party artifacts:

```sh
npm run prepare:first-party-plugins --workspace @zen/zenx
node --import tsx --test apps/zenx/test/user-mcp.test.ts apps/zenx/test/user-mcp-live-host.test.ts
node --import tsx apps/zenx/scripts/smoke-user-mcp-codex.ts
```

The first command is a normal build prerequisite. The test creates a real private
HostedAppServer with the canonical filesystem journal, ordinary bundled plugin
Catalog/runtime/storage, BoardHostService and ThreadSidebarStore. A local fake
model is used only to seed a real canonical Turn without credentials. Tool
responses are read from those actual services, not fixed fixture JSON.

The official SDK Client launches that Host in a subprocess and exercises real MCP
initialization/discovery, Thread history, Board read/create/conflict/re-read,
sidebar CAS, forged-owner rejection and human-event rejection. Additional SDK
protocol tests use the same real Host in process for Room removal/rejoin,
connection-qualified snapshot retirement, plugin revoke/re-enable, permission
changes and terminal connection revocation. It also verifies shared remembered
Host allow/deny decisions and real async Codex approval acceptance, decline and
revocation while a prompt is pending.

The Codex smoke uses a new temporary CODEX_HOME, no inherited model credentials
and no LLM Turn. It launches the installed Codex app-server and requests
`mcpServerStatus/list`. Verified locally with `codex-cli 0.166.0-alpha.1`: all five
MCP tools discovered. This proves that client's actual MCP handshake and discovery,
not model-driven tool use, another harness, or universal compatibility. It does not
modify the user's Codex configuration or register against a production Host.

## Reference verification

The T3 source checkout inspected was
`5cc99e1c23980d7995a13c47f969b47cb68ed1be`:

- The actual marketing screenshot
  [`apps/marketing/src/assets/app-desktop.webp`](https://github.com/t3dotgg/t3code/blob/5cc99e1c23980d7995a13c47f969b47cb68ed1be/apps/marketing/src/assets/app-desktop.webp)
  shows the conversation and auxiliary panels. Its pixels do not prove transport.
- [`codex-app-server-probe.ts`](https://github.com/t3dotgg/t3code/blob/5cc99e1c23980d7995a13c47f969b47cb68ed1be/packages/effect-codex-app-server/test/examples/codex-app-server-probe.ts)
  uses Codex app-server; the actual client and ACP session runtime pass MCP server
  configuration to providers. That is not evidence that all of T3 is an MCP server.
- The official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x)
  supplies the real server/client protocol and stdio transports. This slice pins
  its maintained v1 SDK at `1.32.2`; it does not hand-roll MCP framing.

The current conclusion is a Zen-native adapter design, informed by inspected
references, rather than an unverified claim to copy T3's architecture.
