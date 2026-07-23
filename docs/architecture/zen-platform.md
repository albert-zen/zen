# Zen Platform Architecture

## System Goal

Zen is a platform built around one Zen App Server system of record. Zen CLI/TUI,
ZenX desktop/web, and IMZen all operate Project and Thread exclusively through
that server.

The architecture exists to keep the product explainable:

- Projects are durable policy and scope boundaries.
- Threads are persistent logical sessions.
- Turns are scheduled executions.
- Items remain the universal record of meaningful state.
- Clients are projections and command surfaces, not alternate sources of truth.

## Architectural Invariants

1. There is one canonical Zen App Server SSOT for Project, Thread, Turn,
   account, and scheduling state.
2. Threads are durable logical sessions and do not require a resident process to
   exist.
3. Turns are scheduled work units. A Turn may be queued, running, waiting,
   canceled, completed, or failed.
4. Project root is immutable identity once the Project exists.
5. Model, permission, and execution policy changes are captured atomically and
   become effective on the next Turn.
6. Concurrency is governed by the single `maxActiveExecutions` limit. Each
   actively executing Turn holds one execution lease for its Agent Executor;
   waiting logical Threads and App Server requests do not consume a lease.
7. Agent-created threads and messages follow the exact same protocol,
   persistence, idempotency, and permission path as UI-originated actions.
8. Clients never mutate durable domain state locally.
9. Provider access is routed through official adapter paths only.
10. The system must not offer a direct provider bypass from any client surface.
11. Item history must remain sufficient to reconstruct the durable work trail.
12. External gateways may persist edge recovery state, but they never become an
    alternate Project, Thread, Turn, Item, provider, or runtime authority.

## Domain Model

### Project

Project is the durable scope boundary. It carries immutable identity, policy,
account binding, and any ownership constraints needed for execution.

Project answers:

- what scope does this work belong to
- which account or policy governs it
- which Threads are allowed to exist under it
- what root path or canonical anchor identifies it

Project root is immutable. If a folder supplies identity, that identity may
seed Project creation, but it does not become mutable Project state afterward.

### Thread

Thread is the persistent logical session. It holds durable conversation and
coordination history, but it does not imply a live agent process.

Thread answers:

- what durable work conversation is this
- what history belongs to it
- what the current server-owned status is

### Turn

Turn is the scheduled execution unit for a Thread.

Turn answers:

- what work should run next
- when the server should schedule it
- what status the execution has reached

Turns exist so the platform can separate durable conversation state from active
execution state.

Policy snapshots are taken at Turn boundary. A running Turn continues with the
snapshot it was granted; future model, permission, and execution policy changes
apply atomically to the next scheduled Turn.

### Item

Item is still the core fact model. Any meaningful transition should be captured
as an Item or be reconstructable from Item history.

Items are used for:

- request and response history
- scheduling facts
- causal links between actions
- provider and execution trace
- UI projections

## Platform Layers

### Clients

Clients are intentionally narrow:

- Zen CLI/TUI
- ZenX desktop/web
- IMZen QQ gateway

Clients send commands and render projections. They do not own the canonical
domain state.

### Zen App Server

The Zen App Server is the platform core.

It owns:

- Project lifecycle
- Thread lifecycle
- Turn scheduling
- durable persistence
- authorization and policy enforcement
- event emission
- provider adapter orchestration
- history reconciliation after restart

The server is the only place where durable Project and Thread facts are
committed.

The server also owns the concurrency guardrail: `maxActiveExecutions` bounds
active execution only. Each actively executing Turn holds one lease for its
Agent Executor. Waiting logical Threads do not consume a lease, and the limit
does not cap how many Threads may exist or how many requests the server may
accept.

### Provider Adapters

Provider adapters hide provider-specific APIs behind a stable server-side
contract.

Required rules:

- use a Pi-backed, inference-only ChatGPT subscription OAuth adapter to the Codex Responses transport
- use the adapter's stateful Responses/WebSocket upstream with HTTP fallback
- let Zen own OAuth login, refresh rotation, persistence, and logout without importing another application's credential file
- keep provider state and provider-specific recovery behind the adapter
- never expose a direct provider bypass to a client

Pi `sessionId` is a stable, globally unique provider identity derived
unambiguously from `projectId` plus the project-scoped Zen `threadId`. This
allows provider WebSocket caching and delta continuation without changing Zen
Thread identity or moving canonical context out of the Zen Item history. It is
never a provider-owned Thread or Turn identity.

Each project runtime may retain one lightweight subscription gateway per Zen
Thread and effective model. The gateway keeps only the previous Pi request and
raw AssistantMessage metadata in process memory so the next request can
reconstruct Pi's exact continuation prefix. Provider signatures, encrypted
reasoning, and response ids are never persisted to Items or exposed through
public protocols.

Changing the effective model releases the Thread's provider session and
replaces the gateway before the next Turn. Restart, compaction, or any context
prefix divergence discards the in-memory continuation and rehydrates a full
request from canonical Zen Items.

Every requested tool call has exactly one model-visible tool result before a
later model request. Rejection, invalid input, timeout, and execution failure
retain an auditable trace error and append a paired `isError` result. Provider
streams that do not end in exactly one terminal completion or error fail the
Turn instead of recording a false completion.

OAuth login URLs and device codes are process-transient. Provider auth
commands may be deduplicated while concurrently in flight, but they never enter
the durable Project command ledger or replay after restart. Every credential
change invalidates provider sessions authenticated with the previous access
token before later inference can proceed.

The adapter boundary is intentionally stricter than a generic SDK wrapper. The
goal is to make the provider path replaceable without spreading provider
knowledge into the product surfaces.

## Execution Flow

1. A client requests a Project or Thread action from the Zen App Server.
2. The server validates policy, identity, and idempotency.
3. The server records the durable fact as Items.
4. If execution is needed, the server schedules a Turn.
5. The Turn is executed through a provider adapter.
6. Execution output is appended back into Item history.
7. The client renders the server-owned projection of that history.

This flow keeps client behavior and execution behavior decoupled without
introducing another source of truth.

Agent-created threads and messages enter this flow unchanged. They do not use
a side channel, separate persistence layer, or alternate permission check.

## Transport Strategy

### Short Term

The short-term platform can use practical request/response interactions as long
as the server remains authoritative and Item-backed.

Short-term product acceptance also requires the UI to expose one Project
switcher, one Thread sidebar, a prompt-first create/run flow, and provider /
account / model selection. A Project created from a folder path must not
require a second manual Project name.

### Long Term

The canonical client transport should become a WebSocket event protocol.

That event protocol should carry:

- Project updates
- Thread updates
- Turn state changes
- execution stream data
- account and collaboration signals

The WebSocket protocol is not just a transport preference. It is the long-term
contract that makes remote pairing, live collaboration, and IM gateway
integration practical.

## Product Surfaces

### ZenX Desktop/Web

ZenX is the first user-facing proof that the App Server SSOT works. It should
feel focused on durable work, not on file manipulation.

ZenX has two explicit host modes. A direct standalone launch may own one private
production composition and loopback transport. A managed shared launch supplies
a validated loopback App Server URL and capability; in that mode ZenX owns only
its static proxy and Electron window, creates no composition or private
transport, and never closes the shared server. In both modes, the capability
stays in the trusted main process and the renderer uses same-origin
`/request`/`/events` only.

Primary UI intent:

- one Project switcher
- one Thread sidebar
- clear Project and Thread navigation
- concise live execution view
- durable history view
- prompt-first create/run
- provider/account/model picker
- minimal chrome
- no IDE layout inheritance

### Zen CLI/TUI

Zen CLI/TUI is a thin operational surface for the same server contract.

Its job is to prove that the platform is not bound to a single GUI. It should
remain a client of the App Server, not a sidecar runtime with its own state.

CLI/TUI must use the same App Server protocol, persistence, idempotency, and
permission path as ZenX for project creation, thread creation, message
submission, and turn execution.

### IMZen QQ Gateway

IMZen is a QQ gateway client into the same platform. It translates authorized
QQ messages into App Server commands and delivers completed Turn output back to
QQ while preserving the same SSOT and Item history.

IMZen selects an existing Project; it never creates one from QQ. Its only
external-to-Zen association is a QQ-conversation-to-Thread binding. The binding
records the Project id needed for Project-scoped Thread calls, but QQ channels
and users are not Project identities.

Authorized QQ users can list the configured Project's server-owned Threads and
bind a conversation to one after `thread/read` validation. Subsequent input
uses `turn/start` with that exact Project and Thread identity, allowing a Thread
started in ZenX to continue in IMZen without synchronization or journal access.

The gateway may durably retain pairing ownership, conversation bindings, and
pending external delivery. Pending jobs remain until QQ accepts delivery and
use stable idempotency derived from the QQ message id across App Server and QQ
retries. This edge state does not replace server-owned Project, Thread, Turn, or
Item state.

Authorization is deny-by-default: use an explicit QQ user allowlist, or, when
the allowlist is empty, require exact one-time pairing before accepting ordinary
messages. QQ traffic is restricted to official HTTPS REST and trusted QQ WSS
endpoints. Remote App Server traffic uses HTTPS; loopback HTTP is allowed for a
same-machine deployment.

IM messages travel through the same server-side protocol and permission path as
other clients. IMZen cannot call a provider, model, tool runtime, scheduler, or
Project runtime directly.

## Roadmap

### Phase 1: Short-Term Vertical Slice

- Build the Zen App Server SSOT for Projects, Threads, and Turns.
- Ship ZenX desktop/web on top of that server.
- Integrate a Pi-backed, inference-only ChatGPT subscription adapter to Codex Responses.
- Stream execution through the stateful Responses/WebSocket upstream.
- Keep all durable history server-owned.
- Use a stable Project/Thread composite as Pi's session id for provider
  WebSocket caching and delta continuation while rehydrating canonical context
  from Zen Items.
- Enforce `maxActiveExecutions` as the single active-execution limit: each
  actively executing Turn holds one lease for its Agent Executor, while waiting
  logical Threads hold none.

### Phase 2: Cross-Client Parity

- Add Zen CLI/TUI against the same server contract.
- Ensure the same Thread can be opened and resumed from multiple clients.
- Keep client-specific behavior in presentation, not in domain logic.
- Keep agent-originated and UI-originated project/thread/message mutations on
  the same protocol and persistence path.

### Phase 3: Event Protocol

- Stabilize the WebSocket event schema.
- Make Project, Thread, and Turn transitions first-class events.
- Support richer reconnect and replay behavior.

### Phase 4: Collaboration And Multiplicity

- Remote pairing.
- Multi-account support.
- Better account routing and policy separation.

### Phase 5: IM Gateway - Current Initial QQ Vertical Slice

The current implementation work is the initial QQ vertical slice in
`apps/imzen`. This roadmap marker records implementation scope, not verified
feature completeness or production readiness.

- Connect QQ direct and group-at messages through official HTTPS/WSS endpoints.
- Select an existing active Project and bind each QQ conversation to one Thread.
- Route message work only through capability-authenticated App Server requests.
- Derive stable Turn and QQ delivery idempotency from the QQ message id.
- Persist pairing ownership, conversation bindings, and pending external
  delivery so restart can resume the same work.
- Deny access by default through an explicit allowlist or one-time pairing.
- Keep QQ-specific parsing, retry, and delivery behavior isolated in IMZen.
- Keep provider and runtime creation exclusively in the App Server composition.
- Keep the IMZen executable's startup/shutdown ownership limited to its QQ
  gateway, bridge, pending workers, and App Server client.
- Provide one Windows managed launcher that owns one standalone App Server,
  ZenX, and IMZen as a verified process set and shuts the clients down before
  the server.

Live QQ verification, packaging, service supervision, monitoring, network-fault
evidence, and broader IM-provider support remain follow-on work until separately
verified.

## Acceptance Criteria

- Every client surface talks to the same Zen App Server SSOT.
- A Thread can be created, resumed, and inspected without a resident process.
- A Turn is a scheduled execution, not an always-on background session.
- Project root remains immutable after creation.
- Model, permission, and execution policy updates are captured atomically and
  apply to the next Turn.
- `maxActiveExecutions` is the only concurrency limit and counts execution
  leases held by actively executing Turns for their Agent Executors, not
  waiting logical Threads or App Server request volume.
- Provider access goes through Zen's Pi-backed inference-only ChatGPT
  subscription adapter to Codex Responses, with a stateful provider WebSocket
  and HTTP fallback. Zen client transport remains local HTTP/SSE.
- No code path allows a direct provider bypass from client to provider.
- The Pi session id is a stable composite of Project and project-scoped Thread
  identity; canonical context is always recompiled from Zen Items.
- Agent-created threads and messages use the same protocol, persistence,
  idempotency, and permission path as UI actions.
- Item history is sufficient to explain what happened in a Thread.
- ZenX does not require IDE-style workspace, editor, or diff UI to be useful.
- The architecture leaves room for remote pairing, multi-account, and IM
  gateway work without changing the SSOT rule.
- ZenX short-term UX includes one Project switcher, one Thread sidebar,
  prompt-first create/run, and provider/account/model selection.
- A folder-backed Project does not require a mandatory manual Project name.
- IMZen selects an existing Project and never creates a Project from QQ.
- IMZen stores QQ-conversation-to-Thread bindings and durable edge delivery
  state without becoming a second Zen SSOT.
- Duplicate QQ messages retain stable App Server and QQ delivery idempotency.
- QQ ingress is deny-by-default and restricted to official HTTPS/WSS endpoints.
- IMZen has no direct provider or runtime bypass. The IMZen executable does not
  own App Server startup or shutdown; the explicit managed launcher owns the
  shared process set.

## Open Questions

- What is the initial durable data store for the Zen App Server?
- Which events must be included in the first WebSocket protocol version?
- How much of the provider session state should be mirrored in Zen versus kept
  entirely inside the adapter?
- What identity model should the App Server expose for one account, multiple
  accounts, and shared access later?
- Should CLI/TUI and ZenX share exactly the same command schema from day one?
- What minimal replay behavior is required for reconnect after a network or
  server restart?
