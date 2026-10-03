# Experimental harness boundary

Status: isolated, mock-tested design probe. **Not connected to ZenX and not ready for end users.** No external executable is launched, no login is performed, and no provider call is made. This experiment is separate from the Companion/Fleet PR.

## Decision

A multi-harness product is worth exploring, with isolated probes for Zen, official Codex App Server, Claude Code Agent SDK, OpenCode SDK, and DeepSeek Harness ACP. Keep UI/navigation, target identity, capability presentation, and user-facing error vocabulary shared. Keep wire schemas, process ownership, authentication, session history, permissions, and engine-specific event interpretation inside individual adapters. A generic OpenAI model endpoint is not an agent harness.

ZenX currently starts its own hosted Zen App Server. Its `src/protocol/codex` adapter projects Zen into a pinned Codex-compatible surface; that is not a client that runs Codex. The existing manager also exposes native canonical reads and Host-specific capability/configuration control. Replacing its executable with `codex app-server` would not make these operations valid. The production seam needs to sit above engine-specific managers, not inside Core or an LLM-provider adapter.

A foreign engine owns its session history and execution. Its transcript must not be converted into apparently authoritative Zen canonical Items without a separately approved import/replay design. Existing native Threads continue to satisfy the append-only ItemList invariant. External identities must be namespaced by harness and, when integrated with Fleet, device and endpoint; this experiment's `{engine,id}` references are scoped to one already-bound transport, not globally unique handles.

## This slice

`createHarnessAdapter(engine, backend, options)` selects a small engine-specific module. Zen and Codex use an already initialized, authenticated transport with `request(method, params)`; the other injection contracts are below. The original Zen/Codex slice supports explicit session creation, snapshot read, text send (`start` or correlated `steer`), and correlated interruption. It has no queue, implicit retry, fallback, scheduler, session ledger, renderer, or transport implementation.

- Creation pins `read-only` and `on-request`; it does not launch a turn.
- The transport owner must surface approval requests or refuse them. Never auto-approve because an adapter lacks approval UI. This module does not handle inbound server requests.
- Zen sends via `zen/turn/send` and reads canonical `zen/thread/read`; Codex uses official `turn/start`, `turn/steer`, and `thread/read`.
- A successful send means only `accepted`. Consumption remains `unknown`; neither an RPC success nor an assistant text delta proves a particular message entered an inference request.
- `messageId` is application-side correlation for Codex, not a claimed Codex idempotency key. On an uncertain response, do not retry automatically.
- An explicit steer requires `expectedTurnId`. A raced turn ending produces an error, not an invisible new turn.
- Snapshots retain their engine-owned format. They are not unified transcripts or evidence of cross-engine history portability.
- Zen/Codex fork and resume remain unimplemented in this slice. Approval UI, external event streaming, Companion and Side chat remain unimplemented across the probes. The new SDK/ACP modules expose only the operations documented below.

Run without credentials or dependencies:

```sh
node --test experiments/harness-adapters/*.test.mjs
```

The tests prove request mapping, reference isolation, policy defaults, error propagation and honest receipts against mocked wire responses. They do **not** prove real server compatibility, process teardown, permissions, native platform behavior, or model consumption. Before any product enablement, pin actual server versions and test their generated schemas and authenticated lifecycle with explicit user authorization.

## Expanded official SDK/ACP probes

These three modules add actual API-call mappings with injected mocks, not labels on the Codex adapter:

| Engine           | Injected backend                                                       | Implemented mapping                                                                                                                                               | Important difference                                                                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code      | Exports from `@anthropic-ai/claude-agent-sdk` 0.3.288; options `{cwd}` | `startSession(input)` → `query`; `send(ref,input)` → `query` with exact `resume`; historical read → `getSessionInfo` + `getSessionMessages`; fork → `forkSession` | First prompt creates a session; no invented empty-session API. This one-shot probe waits for the terminal SDK result and closes the Query in `finally`. Interrupt/steer are not exposed by this slice. |
| OpenCode         | Official `@opencode-ai/sdk` v1 client; options `{cwd}`                 | `session.create`, `get` + `messages`, `prompt`, `fork`, `abort`                                                                                                   | SDK `{data,error}` wrappers are unwrapped explicitly. Abort is session-scoped, not correlated to a turn ID. Existing-session `prompt` continues that session.                                          |
| DeepSeek Harness | Initialized ACP transport with `request` and `notify`; options `{cwd}` | `session/new`, `session/prompt`, `session/resume`, `session/cancel` notification                                                                                  | No transcript replay/read or fork. Prompt settlement retains exact `stopReason`; `max_tokens` or `cancelled` is not relabeled successful completion.                                                   |

Claude, OpenCode and DeepSeek send operations return `status: settled`, while Zen/Codex return `accepted`. Settlement is an execution boundary, not proof of satisfactory task completion or a per-message read receipt. All retain `consumption: unknown`. Message IDs in the new probes remain caller correlation rather than claims of remote idempotency.

Claude uses the ordinary `default` permission mode and a deny callback for otherwise unhandled approval requests; it does not select `bypassPermissions`, `auto`, or `acceptEdits`. This callback is not a sandbox and does not override permissions already allowed by an SDK or server configuration. OpenCode and ACP retain the bound server's permission policy; these probes do not alter it or automatically approve inbound requests. At integration, a lightweight host approval callback/handler should own those decisions. Model behavior need not be perfectly deterministic before experimentation; observable protocol limitations should simply remain visible.

The injected SDK/client must already be bound to the intended installation and account. Workspace is explicit and fixed per new adapter. No code here starts a process, reads credentials, installs dependencies, changes server policy, or deploys a service. These probes are useful for testing the boundary now; they are not a requirement to build a new orchestration framework first.

## Semantic differences that must remain visible

| Capability                | Zen                           | Official Codex App Server                         | Claude Agent SDK                                                                     | DeepSeek Harness ACP                                            |
| ------------------------- | ----------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Active-turn input         | Native start/steer policy     | `turn/steer`, expected turn identity              | Streaming input documents sequential queued messages; not equivalent to Zen steering | One prompt in flight per session; no baseline steering contract |
| History                   | Native canonical Items        | Provider-owned thread/turn/item projection        | Provider-owned persistent sessions                                                   | Resume without transcript replay                                |
| Fork                      | Native fork/child semantics   | `thread/fork`                                     | Session fork                                                                         | Explicitly unsupported by current ACP surface                   |
| Approvals                 | Host policy                   | Inbound server requests and decisions             | SDK permission controls/callbacks                                                    | One-shot allow/reject request                                   |
| Exact message consumption | Needs canonical proof         | Do not infer from RPC acceptance                  | Do not infer from stream submission                                                  | Do not infer from prompt submission                             |
| Product-specific tools    | Native Host capability system | Dynamic tools are experimental; MCP also possible | SDK/MCP tools                                                                        | MCP; resources/prompts lack DSH consumer                        |

Capabilities need an evidence-bearing state (supported, unavailable, unknown), tied to endpoint/version. Unsupported fork must not silently become a summary; unsupported steering must not silently become queued input. An external Companion should remain unavailable until explicit IM-post tools, context consumption evidence, trigger delivery, and lifecycle recovery are verified for that backend. Side chat requires an actual fork plus a non-executing instruction append or a clearly disclosed alternative.

## Raven: relevant reference, not a dependency

The best match for the user's spelling and harness discussion is [EverMind-AI/Raven](https://github.com/EverMind-AI/Raven). A distinct [raven-nest](https://github.com/GeronimoDiClemente/raven-nest) is a multi-CLI desktop terminal workspace; the name alone cannot conclusively identify the intended product. This comparison inspected source, not a running Raven UI or its performance claims.

Inspected Raven commit: `f7d9e690549ffedf9a8fa5caeb3d39695872917e`.

Useful ideas:

- [Capability snapshots](https://github.com/EverMind-AI/Raven/blob/f7d9e690549ffedf9a8fa5caeb3d39695872917e/raven/acp_client/capabilities.py) distinguish handshake evidence from human-declared CLI capabilities; launch-configuration fingerprints invalidate stale observations.
- [Explicit protocol extensions](https://github.com/EverMind-AI/Raven/blob/f7d9e690549ffedf9a8fa5caeb3d39695872917e/raven/acp_client/protocol.py) advertise nonstandard steering and session-scoped MCP instead of pretending ACP provides them universally.
- [Wake coalescing](https://github.com/EverMind-AI/Raven/blob/f7d9e690549ffedf9a8fa5caeb3d39695872917e/raven/proactive_engine/wake.py) merges concurrent completion/event wakes and rate-limits feedback loops. Zen should apply this within its existing Triggers ownership, not add another scheduler.
- [Output limits](https://github.com/EverMind-AI/Raven/blob/f7d9e690549ffedf9a8fa5caeb3d39695872917e/raven/agent/subagent/backends/base.py) explicitly flag truncation and retain the full result rather than showing a partial answer as complete.

Do not copy these choices blindly:

- Raven's [ACP approval handler](https://github.com/EverMind-AI/Raven/blob/f7d9e690549ffedf9a8fa5caeb3d39695872917e/raven/acp_client/permissions.py) prefers `allow_always`, subject to its own deny rules. Its [Codex preset](https://github.com/EverMind-AI/Raven/blob/f7d9e690549ffedf9a8fa5caeb3d39695872917e/raven/agent/subagent/presets.py) sets full-access mode. Those defaults do not satisfy Zen's need to preserve user-visible permission boundaries across adapters.
- Its native ACP steering is a Raven extension, not evidence every ACP agent can accept live input.
- Its autonomous planner, memory/evolution stack, and durable DAG machinery are substantial product commitments. They should not be imported merely to obtain multi-harness execution; several conflict with Zen's present non-goals.

## Primary sources and inspected versions

- Zen main `ba0232e0ae9ee5d2086feee744eb0e7a29c48c7b`; Companion PR head at research time `9bef23aed2f0daebd68da338b49f87a8600b2b9b`. Reviewed `AGENTS.md`, `ARCHITECTURE.md`, `LESSONS.md`, ZenX `app-server-host.ts`, `app-server-manager.ts`, and protocol-client method/types. Main was verified via remote refs on 2026-10-03.
- Generated schema spot-check at Codex commit `b741e480e203f037ca726bc2a76d99a8e8668e66`: [SandboxMode](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/app-server-protocol/schema/typescript/v2/SandboxMode.ts) uses `read-only`; [AskForApproval](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/app-server-protocol/schema/typescript/v2/AskForApproval.ts) uses `on-request`. Some website examples instead use camelCase. The probe follows generated wire enums, not those examples; this source observation still does not certify an installed server version.
- [Official Codex App Server contract](https://developers.openai.com/codex/app-server/): create/read/fork, explicit active-turn steer, stream events, server-request approval, experimental dynamic tools. Online contract inspected 2026-10-03; **not a version pin or execution test**.
- Claude SDK declarations were read from the official npm package `@anthropic-ai/claude-agent-sdk@0.3.288` without installation or execution, including query, session utilities and permission modes. [Official TypeScript SDK repository](https://github.com/anthropics/claude-agent-sdk-typescript).
- [OpenCode official SDK documentation](https://opencode.ai/docs/sdk/) and [v1 generated operation types at 907b3bc](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/sdk/js/src/gen/types.gen.ts): session request/response shapes. This probe uses the v1 SDK, not its distinct v2 flat-argument interface.
- [Claude SDK streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) and [sessions](https://code.claude.com/docs/en/agent-sdk/sessions): streaming interaction and session fork. No claim of equivalent active-turn consumption acknowledgments.
- [DeepSeek ACP contract](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/acp/acp/README.md): explicitly automation-only, persistence without replay/fork, one prompt per session, quiescent settlement. Source and ACP implementation were inspected 2026-10-03; the remote master observation was pinned to `5badb15009ae1756c3afe0ae0cef1faafc290ccc`. Runtime capabilities still need checking when a connection is opened.

## Next experiment, before adoption

1. Add a pinned official Codex transport with explicit process/connection ownership, conservative approval handling, cancellation and disconnect tests.
2. Integrate only a developer-gated session view and normalized completed-message projection. Keep raw engine evidence accessible and distinguish unsupported metadata.
3. Establish exact read-receipt evidence and Room-post tool support before allowing a foreign Companion binding.
4. Exercise the existing Claude, OpenCode and DeepSeek probes against their real authenticated interfaces when that validation is authorized. Expand shared behavior only where those integrations demonstrate equivalent semantics; retain local adapter differences elsewhere.

## Verification checkpoint

Implementation commit `032ac03fcc871eb6110901859947ee4540c2dbde`: 15/15 mock tests, JavaScript syntax checks, focused Prettier checks and `git diff --check` passed. Independent review round 1 found no consequential blocker within this bounded mock-only scope; additional in-memory error/no-retry and cross-engine checks passed. Later documentation adds the schema source pin without changing code. No full production suite or real external-engine test was run because this experiment is not imported into the product.

Expanded SDK/ACP implementation `8f749ace760dc3fdd42efab4bd6b6bb9594f388c`: 26/26 tests passed, plus syntax/format/diff checks. Independent review of the new scope passed, including additional in-memory failure, identity, cleanup and permission-callback probes. Official pinned OpenCode and DeepSeek source bytes were fetched and matched the inspected files. This remains mock-only integration evidence; no real SDK/server process, provider or account was exercised.
