# IMZen PRD

## Status

The current implementation target is an initial QQ vertical slice. The slice
establishes the gateway, security, binding, idempotency, and recovery contracts
below. Its presence in the repository is not evidence that every acceptance
criterion has passed against live QQ or that production operations are
complete.

## Problem

Zen work is available through Web and desktop surfaces, but a user in QQ cannot
submit work to an existing Zen Thread or receive its result without switching
clients. A naive bot integration would risk creating a second source of truth,
bypassing Project policy, duplicating Turns when QQ retries a message, or losing
a completed result when external delivery fails.

IMZen solves this as a narrow QQ gateway client. It translates authorized QQ
messages into ordinary Zen App Server requests and translates completed Zen
Turn output back into QQ messages. Zen owns the work; IMZen owns only the QQ
edge.

## Goals

- Support QQ direct messages and group-at messages through official QQ bot
  endpoints.
- Select an existing Zen Project and bind each QQ conversation to one Zen
  Thread.
- Submit QQ input through the same App Server protocol, authorization,
  idempotency, persistence, scheduling, provider, and runtime path as other
  clients.
- Make retries stable across QQ redelivery, App Server retries, QQ delivery
  retries, and IMZen process restart.
- Deny access by default and support either an explicit QQ user allowlist or a
  one-time local pairing flow.
- Preserve pending external work-response delivery durably until QQ accepts the
  response.
- Give the IMZen process explicit startup and shutdown ownership without making
  it the owner of the Zen App Server.

## Non-Goals

- Creating, importing, or mutating a Zen Project from QQ.
- Mirroring Project, Thread, Turn, Item, provider, or execution state into an
  independent IMZen domain store.
- Mapping QQ identities directly to Projects or creating one Project per QQ
  conversation.
- Calling a model provider, tool runtime, scheduler, or Project runtime
  directly.
- Replacing ZenX as the Project and policy administration surface.
- Claiming exactly-once delivery across QQ and Zen. The design uses durable
  retry plus stable idempotency keys.
- General support for non-QQ IM providers in the initial slice.

## Product Boundary

```text
authorized QQ message
  -> IMZen QQ gateway
    -> Zen App Server client
      -> existing Project
        -> bound Thread
          -> scheduled Turn
            -> server-owned provider/runtime
  <- durable QQ delivery retry
```

The Zen App Server is the SSOT. It owns Project and Thread identity, Turn
creation and status, Item history, policy, provider access, and execution.
IMZen's persisted state is an edge recovery record only:

- the paired owner identity when pairing mode is used
- a QQ conversation id to Zen Thread binding, including the Project id needed
  to address that Thread through the protocol
- pending QQ-originated jobs and delivery retry metadata

There is no IMZen-owned message history or alternate Thread representation.

## Existing Project Selection

IMZen never creates a Project. Before it creates or resolves a conversation's
Thread, it selects an existing active Project in one of two ways:

1. `IMZEN_PROJECT_ID` selects an explicit Project, which must be readable from
   the App Server.
2. Otherwise, `IMZEN_PROJECT_ROOT` is resolved to a real local path and matched
   against the canonical root of an active Project returned by the App Server.

If no active Project matches, the operation fails with guidance to create the
Project in ZenX or configure an existing Project id. IMZen must not fall back to
`project/create`.

Project selection is a gateway configuration decision, not an external
conversation binding. The only IM-to-Zen binding is:

```text
QQ conversation id -> Zen Thread id
```

The binding also records the selected Project id because Thread protocol calls
are Project-scoped. A conversation has one current Thread. `/new` creates a new
Thread in the selected existing Project and atomically replaces that
conversation's binding; it does not create or rebind a Project.

## QQ Conversation And Command Behavior

The initial slice accepts:

- QQ `C2C_MESSAGE_CREATE` as a `c2c:<user-open-id>` conversation
- QQ `GROUP_AT_MESSAGE_CREATE` as a `group:<group-open-id>` conversation after
  stripping the bot mention

Supported commands are:

- `/help`: list the initial commands
- `/status`: report the bound Zen Thread's current status
- `/threads`: list existing Threads in the configured Project
- `/bind <threadId>`: validate an existing Project Thread through the App Server
  and replace the conversation binding
- `/new [objective]`: create and bind a new Thread in the selected Project
- `/pair <code>`: claim the bridge owner only while unconfigured pairing is
  available

The first authorized non-command message creates a Thread when no valid binding
exists. Later messages reuse the binding. A missing or archived Project/Thread
must not silently redirect work to a different Project; only the documented
binding recovery path may create a replacement Thread in the configured
existing Project.

Messages in the same QQ conversation are processed in order. Different
conversations may make progress independently, subject to App Server policy and
the server-owned `maxActiveExecutions` limit.

## Authorization And Pairing

Authorization is deny-by-default:

- When `IMZEN_ALLOWED_USER_IDS` is non-empty, only listed QQ user ids are
  accepted. Pairing is not opened as a fallback.
- When the allowlist is empty and no durable owner exists, ordinary messages
  are ignored. The process generates a short-lived pairing code and exposes it
  only to the local operator. The first QQ identity to send the exact pairing
  command claims the durable owner record.
- When the allowlist is empty and an owner exists, only that owner is
  authorized.
- Unauthorized content receives no work execution and no information-bearing
  reply, except the successful exact pairing exchange.

The QQ app secret is loaded from an explicit credential file. It is not stored
in IMZen state and must not be accepted through a QQ message.

Authorization at the QQ edge supplements, but never replaces, App Server
capability and Project policy checks.

## Endpoint And Credential Policy

IMZen connects only to trusted endpoints:

- QQ access tokens use the official `https://bots.qq.com` endpoint.
- QQ REST calls use the official production
  `https://api.sgroup.qq.com` or sandbox
  `https://sandbox.api.sgroup.qq.com` origin.
- The gateway URL discovered from QQ must use `wss://` and a `qq.com` host.
- User information in endpoint URLs is rejected.
- The Zen App Server URL must use HTTPS, except that loopback HTTP is permitted
  for a same-machine deployment.
- App Server requests require an explicit capability credential. The capability
  must not be placed in QQ content or persisted in the IMZen state file.

Redirecting QQ REST or WebSocket traffic to arbitrary hosts is not a supported
extension seam. Adding another IM provider requires another gateway adapter
with its own endpoint trust policy.

## Idempotency And Durable Delivery

QQ can redeliver inbound events and an IMZen process can fail after starting a
Turn or after QQ accepts a reply. The initial slice therefore uses stable keys
at every mutation boundary:

- The durable pending-job record is keyed by the QQ message id, so duplicate
  delivery while a job is pending does not schedule parallel work.
- `turn/start` uses an App Server idempotency key derived from the stable QQ
  message id. A retry cannot intentionally create a second Turn for the same QQ
  input.
- After the App Server returns a Turn id, IMZen persists that id before polling
  for completion. Restart recovery resumes the same Turn rather than starting a
  replacement.
- A QQ delivery id is derived from the inbound QQ message id and Zen Turn id.
  Each output chunk derives the same deterministic QQ `msg_seq` on every retry.
- QQ duplicate-delivery responses are treated as successful acknowledgement,
  not as a reason to generate a new sequence.

The pending job is written before work is scheduled and remains durable while
the Turn is queued, running, awaiting output, or awaiting QQ acceptance. It is
removed only after the external QQ send succeeds or is acknowledged as a
duplicate. Pending jobs are reloaded and retried after restart with bounded
exponential backoff.

This is an at-least-once recovery design combined with stable downstream
idempotency. It must not be described as a distributed exactly-once guarantee.

## Provider And Runtime Isolation

IMZen uses the public App Server client for `project/list`, `project/read`,
`thread/create`, `thread/read`, and `turn/start`. It does not instantiate an
App Server, provider client, model gateway, tool runtime, scheduler, or Project
runtime.

Provider selection, authentication, continuation handles, tool permissions,
execution policy, scheduling, persistence, and Item append behavior remain
inside the Zen App Server composition. An IMZen feature that requires direct
provider or runtime access is out of architecture and must be redesigned as an
App Server protocol capability.

## Startup And Shutdown Ownership

The IMZen executable owns this startup sequence:

1. Load and validate configuration and the QQ credential file.
2. Open and validate durable IMZen edge state.
3. Construct the capability-authenticated App Server client.
4. Construct the QQ gateway and bridge.
5. Resume pending jobs from durable state.
6. Connect QQ ingress and wait for a ready gateway session.
7. Report readiness only after the bridge and gateway are started.

On `SIGINT`, `SIGTERM`, an optional absolute `IMZEN_SHUTDOWN_FILE` marker, or
startup failure, the process removes its signal handlers, stops QQ ingress and
bridge work, closes its App Server HTTP client to abort in-flight requests and
SSE subscriptions, waits for owned tasks to settle, and reports failures without
deleting pending state. It never shuts down the external App Server or its
provider runtime.

The Windows managed live command is an explicit process owner above the client
executables. It starts one standalone App Server, then gives its URL and
capability to IMZen and ZenX. Separate per-run `IMZEN_SHUTDOWN_FILE`,
`ZEN_DESKTOP_SHUTDOWN_FILE`, and `ZEN_APP_SERVER_SHUTDOWN_FILE` markers allow it
to request both clients' shutdown before asking the App Server to stop,
preserving server availability while client work drains. Its descriptor keeps
verified process identities and marker paths but never the capability or QQ
credential.

## Current Slice Acceptance

- IMZen behaves as a client of an existing capability-protected App Server.
- No IMZen request uses `project/create`.
- Explicit Project id selection and active canonical-root matching fail closed
  when the Project cannot be read or found.
- Each QQ conversation binds only to a Zen Thread in the selected Project.
- `/threads` reads server-owned Project Threads and `/bind` persists only after
  the selected Thread is successfully read from the App Server.
- Duplicate QQ inbound message ids reuse the same App Server Turn idempotency
  key.
- The pending record survives restart and is retained through QQ delivery.
- QQ chunk sequence ids remain stable across delivery retry.
- Empty allowlist plus no owner authorizes nobody before exact pairing.
- A non-empty allowlist does not silently enable pairing.
- QQ REST and gateway endpoints pass the official HTTPS/WSS trust checks.
- Remote plaintext App Server endpoints are rejected; loopback HTTP remains
  available for same-machine operation.
- Provider and runtime access remains reachable only through App Server
  requests.
- Shutdown settles IMZen-owned gateway and bridge resources without claiming
  ownership of the App Server.

Live QQ connectivity, credential provisioning, reconnect behavior under real
network faults, packaging, service management, monitoring, and sustained-load
limits require separate operational evidence before the slice can be called
production-complete. The durable pending-job path covers accepted work and its
final response; restart-durable recovery for immediate control-command
acknowledgements is not established by this slice.
