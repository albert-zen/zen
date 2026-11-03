# Actual Codex turn with a local protocol fixture

`npm run smoke:user-mcp-codex-turn --workspace @zen/zenx`

Prerequisites: the repository dependencies and first-party plugin bundles prepared
as for the existing `smoke:user-mcp-codex`, plus an installed Codex executable.
Set `ZEN_CODEX_EXECUTABLE` if it is not on PATH.

This opt-in smoke uses the **actual Codex app-server** and official MCP SDK stdio
transport. Its default mode keeps the existing `real-user-mcp-stdio.ts` Host
composition. Only the model provider is a deterministic loopback Responses
protocol fixture. It does not exercise a real LLM's decisions, model quality,
Desktop approval UI, production registration, login, or OAuth.

## Already-running Desktop child mode

Prepare the built main entries from the exact checkout first:

`npm run build:prepared --workspace @zen/zenx`

Then run the same smoke with:

`ZEN_MCP_CODEX_LIVE_HOST=1 ZEN_MCP_TEST_USE_BUILT=1 npm run smoke:user-mcp-codex-turn --workspace @zen/zenx`

The existing `createLiveUserMcpHost` test fixture explicitly boots an actual
private `AppServerManager` child and seeds its history **before Codex starts**.
Codex launches the built production `user-mcp-stdio-cli.js` with that existing
Host's explicit `--descriptor` and `--thread`. The launcher only connects; it
does not boot the Host or create its owner Thread. Omit
`ZEN_MCP_TEST_USE_BUILT=1` to check the source Host/launcher instead.

This mode retains the same nine tool calls, ten Responses requests, CAS conflicts,
deep Board/sidebar readback and terminal assertions. It additionally checks:

- Host PID, process epoch and native Thread item count are identical before and
  after Codex's turn and the independent reads. No Host restart or new Host Turn
  is hidden behind the launcher.
- A second official SDK client uses a separate production launcher connection to
  deep-compare the full Board document and confirm the same sidebar is open.
- The live fixture receives the deliberate clean environment for both its pnpm
  processes and its `AppServerManager` child, including the rejecting local proxy.

The Host uses a deterministic fake provider only to seed synthetic history. No
real user Host or credentials are accessed. The generated private transport token
is confined to this temporary Host. Both modes are explicitly Thread-bound;
neither validates Room/workspace Board ownership or Desktop/Electron UI.

## What is asserted

1. Codex discovers all five tools on its own thread's actual MCP connection.
2. Codex sends an actual streamed Responses request to the loopback provider.
3. The fixture returns function calls from the actual request's MCP namespace.
4. Codex invokes the real history/Board/sidebar Host tools over stdio, then returns
   their actual `function_call_output` payloads to subsequent provider requests.
5. Board replacement applies against its immutable snapshot. Reusing the old
   snapshot conflicts, and a complete read is deep-compared against the entire
   expected authored document (including its projected owner).
6. Sidebar opening applies against its immutable snapshot. A stale closing patch
   conflicts, and a read confirms the sidebar remains open.
7. All nine MCP calls complete, all nine real outputs satisfy assertions, and
   Codex emits `turn/completed` with status `completed` and the final fixture marker.

There are ten actual provider requests in one actual Codex turn. Both conflict
calls are deliberate assertions, not automatic mutation retries.

## Isolation and approval boundaries

- A private temporary `CODEX_HOME`, HOME, workspace and Host data root are used and
  removed even if setup fails before Codex starts. Parent environment variables
  and credentials are not inherited. The live Host and provider are closed on
  setup failure as well as turn success/failure.
- The fixture binds only `127.0.0.1`, performs no upstream requests, checks that
  provider requests contain no authorization/cookie/API-key headers, and rejects
  incidental background HTTP(S) proxy requests locally. This is not a kernel-level
  network isolation guarantee. Blocked target names, not request bodies or
  credentials, appear in the summary.
- Codex's shell sandbox remains read-only. Only the two fixed synthetic MCP write
  tools receive `approval_mode = "approve"` in this temporary client config.
  The Host's existing permissions and admission path are unchanged.
- Other unsolicited Codex client requests are rejected. No approval prompt is
  automatically accepted. This is not a Host/Desktop approval test.
- Discovery explicitly passes `threadId`. Global discovery can launch a second
  MCP process, which must not share this fixture's single-writer Host root.

## Protocol and config references

The smoke was checked against installed `codex-cli 0.166.0-alpha.1`, including
its actual generated `ThreadStartParams`, `TurnStartParams`, `UserInput`,
`ListMcpServerStatusParams` and `ThreadItem` protocol definitions:

`codex app-server generate-ts --experimental --out /tmp/codex-protocol`

Custom provider fields are validated with Codex `--strict-config`. The scoped
MCP approval override follows the official
[configuration reference](https://developers.openai.com/codex/config-reference).
The script intentionally fails if a later Codex version no longer presents the
observed namespaced Responses/tool-output shapes; discovery alone is not success.
