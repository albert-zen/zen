# Actual Codex turn with a local protocol fixture

`npm run smoke:user-mcp-codex-turn --workspace @zen/zenx`

Prerequisites: the repository dependencies and first-party plugin bundles prepared
as for the existing `smoke:user-mcp-codex`, plus an installed Codex executable.
Set `ZEN_CODEX_EXECUTABLE` if it is not on PATH.

This opt-in smoke uses the **actual Codex app-server**, official MCP SDK stdio
transport, and existing `real-user-mcp-stdio.ts` Host composition. Only the model
provider is a deterministic loopback Responses protocol fixture. It does not
exercise a real LLM's decisions, model quality, Desktop approval UI, production
registration, login, or OAuth.

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
  and credentials are not inherited.
- The fixture binds only `127.0.0.1`, performs no upstream requests, checks that
  provider requests contain no authorization/cookie/API-key headers, and rejects
  incidental background HTTP(S) proxy requests locally. Blocked target names, not
  request bodies or credentials, appear in the summary.
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
