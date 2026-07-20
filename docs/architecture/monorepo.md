# Zen Monorepo Architecture

## Purpose

The monorepo separates reusable Zen behavior from executable product edges.
`packages/framework` contains the item-first kernel, product protocol, Node
adapters, and presentation projections. Each directory under `apps/` is an
independently owned process or browser surface that composes those public
framework APIs.

This split must preserve the platform rule: the Zen App Server is the system of
record for Project, Thread, Turn, Item, provider, policy, and scheduling state.
Moving code into a monorepo does not grant an app a second domain path.

## Workspace Map

```text
packages/
  framework/   reusable kernel, product, Node adapter, and presentation APIs

apps/
  cli/         standalone App Server and Web development process entry points
  web/         browser client and Project/Thread presentation
  zenx/        Electron host for the Web client and a local App Server
  imzen/       QQ gateway client for an already-running Zen App Server
```

Tests, acceptance fixtures, end-to-end fixtures, scripts, and documentation
remain repository-level support surfaces. They may compose public package APIs,
but they are not production dependency roots.

## Dependency Direction

Production source dependencies point from executable edges into the framework:

```text
apps/cli   ----+
apps/web   ----+
apps/zenx  ----+--> @zen/framework
apps/imzen ----+
```

The applications do not form a domain dependency chain. In particular:

- `apps/web` does not import Electron, CLI, IMZen, Node persistence, provider,
  or runtime implementations.
- `apps/zenx` hosts the built Web assets, but the Web client does not depend on
  ZenX. This is a packaging relationship, not permission to put product logic
  in the Electron shell.
- `apps/cli` may host the Web development server, but Web product behavior
  remains in `apps/web` and framework presentation modules.
- `apps/imzen` depends on the public App Server client and protocol. It does not
  import another app and must not compose a provider or Project runtime.
- No app may deep-import another package's `src/` tree. Cross-boundary behavior
  uses declared package exports.

`packages/framework` exposes four public module groups:

```text
@zen/framework               kernel
@zen/framework/product       App Server and product contracts
@zen/framework/node          Node adapters and production composition
@zen/framework/presentation  client-side projections and transport clients
```

Their internal dependency direction points inward:

```text
kernel <- product <- adapters/node
           ^
           +------ presentation
```

- `kernel` owns `ItemList`, `AgentLoop`, context and hook behavior, and neutral
  model/tool interfaces.
- `product` owns Project, Thread, Turn, approval, scheduling, coordination, and
  App Server protocol behavior. It may depend on the kernel, never on Node or an
  application.
- `adapters/node` implements filesystem persistence, HTTP transport, provider
  integration, local tools, and process composition behind product contracts.
- `presentation` projects the public product protocol into client state. It may
  depend on product contracts, never on Node adapters or executable apps.

## Application Responsibilities

### `apps/cli`

The CLI package owns executable process composition. Its standalone entry point
creates the production App Server composition, exposes the capability-protected
HTTP transport, publishes the local client handoff, and owns signal-driven
shutdown. Its Web development entry point additionally owns the Vite host and
proxy for that process lifetime.

CLI/TUI product commands remain clients of the same App Server protocol. A CLI
entry point must not call Project managers, schedulers, provider services, or
tool runtimes as an alternate command path.

### `apps/web`

The Web package owns browser rendering and interaction state. It sends App
Server requests and renders server projections. Browser-local selection,
pending form state, and transport connection state are projections, not durable
domain facts.

The Web client never owns App Server startup or shutdown. Its containing host,
such as the CLI development process or ZenX, owns that lifecycle.

### `apps/zenx`

ZenX owns the Electron edge: single-instance policy, native window and IPC,
static asset hosting, loopback transport, and the local production App Server
composition. Electron IPC is limited to platform capabilities and must not
become a second product protocol.

The desktop startup order is:

```text
production App Server composition
  -> loopback App Server transport
  -> static Web host and API proxy
  -> Electron window
```

Shutdown first quiesces ingress, then closes the product composition so active
work can settle, then closes transport, host, and window resources. The desktop
lifecycle owner aggregates failures and makes repeated close requests
idempotent.

### `apps/imzen`

IMZen is a QQ gateway client, not an embedded Zen runtime. It owns QQ
authentication, the official QQ HTTPS/WSS connection, message normalization,
authorization at the external edge, conversation-to-Thread bindings, and
durable pending external delivery. It connects to an existing App Server with
an explicit URL and capability.

IMZen may retain only edge state needed to operate the gateway: pairing owner,
QQ-conversation-to-Zen-Thread bindings, and pending jobs/delivery attempts. The
App Server remains authoritative for the selected Project, Thread, Turn, Item,
policy, provider, and execution state.

IMZen startup opens and validates configuration and edge state, constructs the
App Server client and QQ gateway, resumes durable pending work, then opens QQ
ingress. The IMZen process owns its signal handlers, QQ gateway, bridge workers,
and their shutdown. It does not own or stop the external App Server.

## App Server Boundary

Every product mutation follows one path:

```text
Web / CLI / ZenX / IMZen
  -> authenticated App Server request
    -> authorization and idempotency
      -> durable Project/Thread command path
        -> Turn scheduling
          -> server-owned provider/runtime adapter
```

The following are prohibited:

- a client calling a model provider directly
- a client constructing a local agent or Project runtime to avoid the server
- Electron IPC carrying Project, Thread, Turn, or provider mutations
- IMZen creating a Project or treating QQ state as canonical Zen history
- an app writing framework persistence files directly

Tests and demos may inject fakes through public composition seams, but no
production entry point may expose a provider or runtime bypass.

## Ownership Summary

| Concern                                             | Owner                        |
| --------------------------------------------------- | ---------------------------- |
| Item append semantics and agent loop                | `packages/framework` kernel  |
| Project, Thread, Turn, policy, scheduling           | Zen App Server product layer |
| Durable Zen persistence and provider adapters       | Server-side Node composition |
| Browser projection and interaction state            | `apps/web`                   |
| Standalone process and Web dev lifecycle            | `apps/cli`                   |
| Electron, local host, and embedded server lifecycle | `apps/zenx`                  |
| QQ connection, pairing, binding, pending delivery   | `apps/imzen`                 |
| QQ-delivered work and resulting history             | Zen App Server               |

## Change Rules

- Put reusable behavior in the deepest framework module that owns the
  invariant; keep process wiring in the app that owns the process.
- Add package exports deliberately. Do not use exports as pass-through aliases
  for app-specific behavior.
- Keep application-local state disposable unless an edge protocol requires
  durable recovery. Edge durability must never compete with App Server facts.
- Preserve startup rollback and shutdown ordering whenever an app adds an owned
  resource.
- A new client surface must use the App Server protocol before it gains provider
  or execution features.
