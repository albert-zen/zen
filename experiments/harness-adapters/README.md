# Experimental harness boundary

Status: isolated, mock-tested design probe. **Not connected to ZenX and not ready for end users.** No external executable is launched, no login is performed, and no provider call is made. This experiment is separate from the Companion/Fleet PR.

## Decision

A multi-harness product is worth exploring, beginning with Zen and the official Codex App Server. Keep UI/navigation, target identity, capability presentation, and user-facing error vocabulary shared. Keep wire schemas, process ownership, authentication, session history, permissions, and engine-specific event interpretation inside individual adapters. A generic OpenAI model endpoint is not an agent harness.

ZenX currently starts its own hosted Zen App Server. Its `src/protocol/codex` adapter projects Zen into a pinned Codex-compatible surface; that is not a client that runs Codex. The existing manager also exposes native canonical reads and Host-specific capability/configuration control. Replacing its executable with `codex app-server` would not make these operations valid. The production seam needs to sit above engine-specific managers, not inside Core or an LLM-provider adapter.

A foreign engine owns its session history and execution. Its transcript must not be converted into apparently authoritative Zen canonical Items without a separately approved import/replay design. Existing native Threads continue to satisfy the append-only ItemList invariant. External identities must be namespaced by harness and, when integrated with Fleet, device and endpoint; this experiment's `{engine,id}` references are scoped to one already-bound transport, not globally unique handles.

## This slice

`createHarnessAdapter(engine, transport)` requires an already initialized, authenticated transport with `request(method, params)`. It supports explicit session creation, snapshot read, text send (`start` or correlated `steer`), and correlated interruption. It has no queue, implicit retry, fallback, scheduler, session ledger, renderer, or transport implementation.

- Creation pins `read-only` and `on-request`; it does not launch a turn.
- The transport owner must surface approval requests or refuse them. Never auto-approve because an adapter lacks approval UI. This module does not handle inbound server requests.
- Zen sends via `zen/turn/send` and reads canonical `zen/thread/read`; Codex uses official `turn/start`, `turn/steer`, and `thread/read`.
- A successful send means only `accepted`. Consumption remains `unknown`; neither an RPC success nor an assistant text delta proves a particular message entered an inference request.
- `messageId` is application-side correlation for Codex, not a claimed Codex idempotency key. On an uncertain response, do not retry automatically.
- An explicit steer requires `expectedTurnId`. A raced turn ending produces an error, not an invisible new turn.
- Snapshots retain their engine-owned format. They are not unified transcripts or evidence of cross-engine history portability.
- Fork, resume, approval UI, streaming, Companion and Side chat are deliberately unimplemented in this slice, even where an engine could support them.

Run without credentials or dependencies:

```sh
node --test experiments/harness-adapters/adapter.test.mjs
```

The tests prove request mapping, reference isolation, policy defaults, error propagation and honest receipts against mocked wire responses. They do **not** prove real server compatibility, process teardown, permissions, native platform behavior, or model consumption. Before any product enablement, pin actual server versions and test their generated schemas and authenticated lifecycle with explicit user authorization.

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
- [Claude SDK streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) and [sessions](https://code.claude.com/docs/en/agent-sdk/sessions): streaming interaction and session fork. No claim of equivalent active-turn consumption acknowledgments.
- [DeepSeek ACP contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md): explicitly automation-only, persistence without replay/fork, one prompt per session, quiescent settlement. This mutable source was inspected 2026-10-03; its advertised capabilities must be rechecked at implementation time.

## Next experiment, before adoption

1. Add a pinned official Codex transport with explicit process/connection ownership, conservative approval handling, cancellation and disconnect tests.
2. Integrate only a developer-gated session view and normalized completed-message projection. Keep raw engine evidence accessible and distinguish unsupported metadata.
3. Establish exact read-receipt evidence and Room-post tool support before allowing a foreign Companion binding.
4. Add Claude and ACP only after two real integrations expose stable shared boundaries. Do not build a generic adapter framework around imagined equivalence.

## Verification checkpoint

Implementation commit `032ac03fcc871eb6110901859947ee4540c2dbde`: 15/15 mock tests, JavaScript syntax checks, focused Prettier checks and `git diff --check` passed. Independent review round 1 found no consequential blocker within this bounded mock-only scope; additional in-memory error/no-retry and cross-engine checks passed. Later documentation adds the schema source pin without changing code. No full production suite or real external-engine test was run because this experiment is not imported into the product.
