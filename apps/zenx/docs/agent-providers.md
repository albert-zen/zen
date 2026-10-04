# Agent Providers (experimental)

This feature is being developed on a separate branch for review. It does not merge the previous mock adapter experiment back into the product.

## Product model

An **Agent Provider** is a complete agent engine. A configured **instance** identifies that engine on a Host. A **model** is chosen from that instance's catalog. Zen's existing OpenAI-compatible endpoints and model profiles remain below Zen; they are not peers of Codex or OpenCode.

Settings provides engine-instance configuration. New conversations choose workspace, Agent Provider and then a model from its catalog. An existing conversation stays attached to the same instance and native session. Changing a default does not change old sessions. There is no silent cross-engine fallback or migration.

## Ownership and compatibility

- Zen-native Threads keep their existing append-only ItemList, settings, tools, approvals and navigation. No old journal or profile is rewritten.
- External engines keep their own native session/history. ZenX stores only Host / instance / native-session / workspace locators and displays transient projections.
- The Host uses the existing local Fleet identity without enabling Fleet hosting. Native processes survive window closure and stop with application Quit.
- External engine credentials remain in the engine's native configuration. No login is started by catalog discovery.
- PAW, Room, IMZenX and Fleet continue to bind their current explicit Zen-native Threads. External-engine integration for these capabilities is not claimed by this slice.
- Native unsupported inputs/approvals produce errors. The application never substitutes generic approval for an unrepresentable native question.

## Initial provider scope

Zen uses its existing Host. Codex is controlled through the installed `codex app-server` newline JSON protocol. OpenCode is controlled through a Host-owned local `opencode serve` HTTP/SSE connection.

Codex's native sandbox modes are preserved. OpenCode's permission rules are tool approvals, not an OS filesystem sandbox: read-only/workspace-write cannot be claimed equivalent and are rejected until an actual protection boundary exists. OpenCode may run only with explicit full-filesystem access; its configured native allow/ask/deny policy remains in control.

Claude and DeepSeek Harness require distinct integrations, not model API wrappers. They must not appear as enabled engines before their session, interruption, permission and restoration capabilities are implemented and tested. DeepSeek model API configuration remains a model-service option inside Zen and must not be mislabeled as DeepSeek Harness support.

## Verification boundaries

Spawned protocol-server fixtures exercise process lifecycle and native request/event translation without credentials or paid model calls. They do not certify real provider autonomous quality, authentication, remote-device support or every native tool item. Final validation and source references are recorded with the reviewed commit.

### Codex protocol boundary

The outbound adapter was checked against the installed official Codex CLI 0.159.2 generated App Server schema and the existing T3 reference snapshot `5cc99e1c23980d7995a13c47f969b47cb68ed1be`. This does not change Zen's separately pinned inbound CAS compatibility facade.

The adapter handles initialize, model pagination, thread start/resume/read (including native paginated history), Turn start/interruption, stream previews, and one-request command/file approvals. Native `requestUserInput`, arbitrary MCP elicitation and authentication callbacks that cannot be represented by the current product controls fail explicitly. They are not converted to blanket approval. The product cannot promise every Codex feature through this initial integration.

To reproduce the offline UI without a real account, configure a Codex instance with the executable fixture `apps/zenx/test/fixtures/codex-app-server-peer.cjs`. It implements a test protocol peer, not a substitute production engine. The default fixture streams a short response; `PEER_SCENARIO=approval` exposes an approval card. Use an isolated QA profile and do not confuse this evidence with a real model run.

### Account configuration in this slice

External instances select an installed executable and use that engine's existing local account/configuration. They do not create separate accounts, log in, import credentials or promise account isolation merely because two display names differ. An unavailable or unauthenticated engine reports its native failure through the explicit model check or session operation. Provider-specific account/profile management remains a later adapter capability; Zen's existing account and model-service configuration remains available beneath Zen.
