# External Agent Provider adapter evidence

Research date: 2026-10-04. This document distinguishes an agent engine from the model endpoint configured inside that engine. Source inspection and local fake-process tests made no credential changes or paid model calls.

## Implemented: OpenCode

`OpenCodeAgentProviderAdapter` owns an explicitly spawned Host-local `opencode serve --hostname 127.0.0.1 --port 0` process. Only that child's readiness URL is accepted; it must be plain HTTP on exactly 127.0.0.1 with an assigned port, no userinfo, path, query, or fragment. A random process-lifetime HTTP Basic password prevents attaching to a pre-existing listener. There is no caller-supplied remote server URL. Direct executable launch uses no shell.

The adapter has no model API client and no canonical session journal. OpenCode owns all messages, session IDs, settings, model routes, and approvals. Zen receives a display projection on native reads. Native SSE text/reasoning presentation is retained only in memory while a session is active, because token deltas can precede native history persistence. Native idle clears this overlay. Interrupt acceptance does not fabricate a completed turn.

Inspected native protocol: OpenCode 1.15.13, SDK v2 generated types. Runtime health rejects versions below 1.15.13 and non-1 major versions; structural validation still rejects unrecognized native shapes rather than substituting data.

- Health: GET /global/health
- Model catalog: GET /provider, filtering its connected IDs, plus GET /config for the selected native default
- Create: POST /session?directory=<Host cwd>, body containing native agent/model, with no permission override
- History: GET /session/{sessionID} and GET /session/{sessionID}/message with native session directory routing. Message reads use explicit limit/before paging to exhaustion, even when a native page is shorter than the requested limit. Repeating pages fail visibly; native response/display bounds fail rather than labeling a partial view complete
- Running state: GET /session/status
- Send: POST /session/{sessionID}/prompt_async with text parts and optional {providerID, modelID}; successful admission is HTTP 204
- Interrupt: POST /session/{sessionID}/abort; settlement still comes from native state/history
- Events: GET /global/event SSE, whose payload encloses directory and the native event
- Pending approvals: GET /permission; permission.asked and permission.replied events
- Reply: POST /permission/{requestID}/reply with once or reject; no persistent always grant

New sessions omit session-level permission overrides: OpenCode retains its configured build-agent allow/ask/deny policy and its native evaluation order. ZenX displays and answers only the native asks; it does not reinterpret allows or weaken denies. OpenCode tool approval rules are not an OS filesystem sandbox. This adapter advertises only danger-full-access and rejects read-only/workspace-write before spawning. No additional sandbox is invented. Structured question.asked cannot be answered by the current shared binary-approval contract; the adapter reports that limitation and leaves the native question untouched. Text-only send is the shared contract; attachments, slash commands, MCP elicitation, session deletion/fork, and native user-input choices are not implemented by this slice.

Sources:

- [Official server documentation](https://opencode.ai/docs/server/)
- [Official SDK documentation](https://opencode.ai/docs/sdk/)
- [Pinned official v2 protocol types](https://github.com/anomalyco/opencode/blob/v1.15.13/packages/sdk/js/src/v2/gen/types.gen.ts)
- Local comparison: the user-provided T3 Code snapshot's OpenCodeAdapter.ts, opencodeRuntime.ts, and pnpm-lock.yaml (SDK 1.15.13). These are implementation examples, not the protocol authority.

Verification: fake local child HTTP/SSE tests cover native discovery, connected-model filtering, creation, explicit model send, streamed display, native history restoration, absence of session permission overrides, one-shot allow and reject, interruption, unknown IDs/models, unavailable sandbox modes, wrong bind URL, incompatible server version, malformed catalog, startup timeout, process exit, complete native backward paging under a lower native page cap, the executable GUI fixture, and teardown. The executable offline fixture is test/fixtures/opencode-app-server.mjs; OPENCODE_PEER_STATE_FILE selects its independent fake-native persistence file for GUI QA. It runs no command or model. Process/stream failures require an application restart, reported explicitly; no hidden retry state machine is introduced. They do not establish a live authenticated OpenCode model turn; no real CLI model call was made.

## Recommended next: Claude Agent

Use the official @anthropic-ai/claude-agent-sdk query API, not the generic Anthropic Messages SDK. The Agent SDK runs the Claude Code binary and owns its tools, agent loop, sessions, and permissions. The current overview marks the TypeScript V2 API as removed, so the old unstable_v2_createSession/send/stream preview is not a suitable foundation.

Concrete session plan:

1. Construct query({prompt: AsyncIterable<SDKUserMessage>, options}) with an adapter-owned input queue, explicit cwd, includePartialMessages: true, explicit permissionMode: default, and canUseTool.
2. Capture native session_id from init/result messages. Subsequent process launches pass options.resume with that ID; do not rebuild context from Zen's displayed messages.
3. Use SDK listSessions and getSessionMessages for native history. The native store is Claude's project-session storage, configurable through CLAUDE_CONFIG_DIR. Prefer these exported readers to hand-parsing an assumed JSONL schema.
4. Deliver tool asks through canUseTool, retaining toolUseID and cancellation signal. Allow replies preserve the original input via {behavior: allow, updatedInput: input}; reject replies return {behavior: deny, message}. Native permission rules resolved before this callback must remain authoritative. AskUserQuestion is a structured interaction, not a yes/no tool approval.
5. Use Query.interrupt and await native settlement; terminating the binary is a teardown operation, not proof of successful interruption. The local T3 Code snapshot uses the real Query.interrupt and distinguishes interrupted/error results.
6. Enumerate model choices through the pinned SDK's supported-model control surface if available, preserving native aliases and capability metadata. Verify the exact exported catalog signature against the chosen SDK distribution before implementation; this research could not retrieve the oversized live TypeScript reference. Do not replace that verification with a static guessed model roster or a generic Anthropic model catalog.

Production constraints from Anthropic: third-party products may not offer claude.ai login/rate limits without prior approval. The official integration guidance prefers “Claude Agent” in agent pickers and disallows “Claude Code” or “Claude Code Agent” as product integration labels. Use supported API-key authentication for a product integration; do not silently reuse or create credentials.

Sources:

- [Official Agent SDK overview and integration restrictions](https://code.claude.com/docs/en/agent-sdk)
- [Official native session/resume/history documentation](https://code.claude.com/docs/en/agent-sdk/sessions)
- [Official streaming input documentation](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [Official approval/user-input documentation](https://code.claude.com/docs/en/agent-sdk/user-input)
- [Official SDK release notes](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)
- Local comparison: user-provided T3 Code ClaudeAdapter.ts pins @anthropic-ai/claude-agent-sdk 0.3.276 and uses query, canUseTool, getSessionMessages, forkSession, and Query.interrupt.

No Claude adapter is implemented in this branch, and its filesystem-sandbox equivalence must be established separately rather than inferred from permissionMode.

## DeepSeek Harness: select a genuine transport

The inspected user-provided official DeepSeek Harness checkout is commit 639ed015397290b3745d163aafe02ffee4aa3f84. Its package APIs are pre-stable, so pin a release/source revision and validate its native capabilities. DeepSeek's OpenAI-compatible model endpoint is not DeepSeek Harness: it supplies model inference but not Harness tools, native sessions/history, plugins, lifecycle, or approvals.

### SDK stdio: insufficient for the full UI contract

The sdk profile launches a genuine Harness process and newline-delimited JSON-RPC 2.0. Its complete client method set is initialize, session/prompt, shutdown. initialize selects cwd/provider/model/reasoningEffort/maxTokens for the process. session/prompt lazily creates a named native session and returns an inbox messageId receipt. Notifications are session.event, session.status, subagent.started, and subagent.finished. The high-level TypeScript DeepSeekHarness wrapper observes receipt through next whole-agent idle; that interval is not a result causally attributed to one prompt.

There is no SDK list/history/cancel/session-close/model-catalog/interactive permission method. Closing the runtime abandons work; it cannot be presented as a normal turn interrupt. The transport library's capacity for server-to-client requests does not mean the SDK server sends permission requests.

### ACP: useful automation, incomplete history/streaming UI

`dsh --profile acp` provides standard ACP v1 over JSON-RPC stdio. It supports initialize, session/new, session/list, session/resume, session/close, session/set_config_option, session/prompt, session/cancel, $/cancel_request, semantic session/update notifications, and one-shot session/request_permission decisions. Native configuration options expose the live provider/model catalog and reasoning_effort; opaque model option values encode the native route and must be used as advertised.

However, resume restores the native log without replaying it. session/load, transcript replay, raw token deltas, forks, deletion, elicitation, client filesystem operations, terminal UI, plans, and human DSH-specific presentation are deliberately unsupported. ACP therefore cannot honestly implement the current AgentProviderAdapter.read full-history requirement alone.

### Full UI: Web session-controller plus authenticated Gateway

The official web profile exposes a full native session controller: session/list, create, modelCatalog, selectModel, prompt, cancel, page, follow, projections and control streams. This is a feasible full-history adapter, but larger than OpenCode's REST/SSE slice.

Exact carrier from the pinned source:

- Unary calls POST /api/<namespace>/<method> with {type: client-request, rpcId, method: <namespace>/<method>, payload: {args: <named arguments>}}. For session methods taking one request object, generated invocation args contain request.
- Response: {type: server-response, rpcId, result: {ok: true, value}} or a typed error.
- Streams use WebSocket /api/remote.mux. Open frames are {type: open, streamId, endpoint, payload: {args}}; server frames are item/error/end, and client cancellation is {type: cancel, streamId}.
- The $events stream opens with {type: ready, clientId, host}; it forwards scoped approval/request waterfalls. Replies POST /api/$events/result with the exact clientId/eventId and bounded native approval outcome. This event-generation identity must be preserved on reconnect.
- session/follow supplies an authoritative opening history snapshot and ordered durable events, plus optional native assistant-stream frames when assistantStream is true. session/page loads older Turn-aligned native history using its cursor; do not manufacture a second journal.
- Web authentication uses the process-generated root URL token to establish a signed, authority-bound HttpOnly cookie. All /api and mux requests must preserve that native trust/authentication boundary. There is no SDK Bearer-header shortcut. Host/Origin checks remain in force.

A production DSH adapter should use this Web contract for all session/control/history operations or add an explicitly versioned first-party bridge plugin to DSH. An ACP live turn plus direct unversioned session-file parsing would mix ownership boundaries and should not be described as a complete native adapter.

Pinned primary sources:

- [Official Harness repository at inspected revision](https://github.com/deepseek-ai/deepseek-harness/tree/639ed015397290b3745d163aafe02ffee4aa3f84)
- [SDK protocol contract](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/sdk/protocol/README.md)
- [SDK client limitations](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/sdk/client/README.md)
- [ACP automation contract](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/acp/acp/README.md)
- [ACP live model configuration source](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/acp/acp/src/model-control.ts)
- [Native session-controller contract](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/api/session-controller/src/types.ts)
- [Gateway stream protocol](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/api/gateway/src/stream-protocol.ts)
- [Web authentication source](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/connection/src/browser-auth.ts)

No DeepSeek Harness adapter is implemented in this branch. Do not activate the permissive sdk-minimal profile as a sandbox substitute; it explicitly uses danger-full-access and can modify any filesystem path visible to its process.
