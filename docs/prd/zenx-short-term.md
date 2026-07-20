# ZenX Short-Term PRD

## Purpose

This document defines the short-term product slice for ZenX, the desktop/web
experience for Zen. It captures the immediate user experience, the first
subscription-backed provider path, and the platform rules that must already
hold in the first release.

The direction is intentionally narrow:

- Zen CLI/TUI, ZenX desktop/web, and future IM Zen all operate Project and
  Thread exclusively through one Zen App Server system of record.
- Threads are persistent logical sessions.
- Turns are scheduled executions, not always-on processes.
- Project root is immutable identity. Folder discovery may prefill a Project,
  but root changes are not part of the product contract.
- Model, permission, and execution policy changes are captured atomically and
  apply to the next Turn, not the current active execution.
- Concurrency is governed by the single `maxActiveExecutions` limit. Each
  actively executing Turn holds one execution lease for its Agent Executor;
  waiting logical Threads and App Server requests do not consume a lease.
- Agent-created threads and messages use the exact same App Server protocol,
  persistence, idempotency, and permissions path as UI actions.
- Provider adapters must use the official Codex app-server path for ChatGPT
  subscription access and the stateful Responses/WebSocket upstream where
  available.
- No client or adapter may bypass the provider stack directly.

## Problem Statement

Zen already wants an item-first kernel, but the product still needs a durable
control plane that makes Projects and Threads feel real to users before the
long-term protocol work lands.

The short-term gap is not model quality. The gap is product coherence:

- users need one place to create, resume, and inspect durable work
- the system needs one server-side authority for thread state and scheduling
- the first experience must feel like a usable agent app, not a terminal, not a
  workspace browser, and not an IDE with diff-centric baggage

## Goals

1. Ship a practical ZenX desktop/web experience that can carry a real user
   through project setup, thread creation, turn execution, and history review.
2. Prove the subscription-backed provider path using the official Codex
   app-server integration.
3. Keep Project and Thread state durable and server-owned.
4. Make Zen CLI/TUI thin clients over the same App Server contract instead of
   separate product silos.
5. Preserve the item-first model: important state changes must be representable
   as Items and reconstructable from Item history.

## Non-Goals

- Source tree browser.
- Integrated editor.
- Diff accept/reject workflow.
- Terminal-first workflow as the primary UX.
- Direct provider SDK calls from the client.
- Multi-account routing.
- Remote pairing.
- IM channel gateway.
- Plugin marketplace.
- Workspace IDE features that assume local file ownership as the main product
  surface.

## Product Principles

### One Server, One Truth

Project, Thread, Turn, and account state must be owned by the Zen App Server.
Clients request actions; the server validates, schedules, and persists them.
Agent-originated actions must enter the same protocol path as UI-originated
actions.

### Durable Threads, Scheduled Turns

A Thread is a persistent logical session. It survives client restarts and
server restarts.

A Turn is a scheduled unit of execution. It can be queued, running, waiting,
canceled, completed, or failed. A Turn is not a permanent process.

Project root is the immutable Project identity. Updates to model, permission,
or execution policy are captured as an atomic snapshot for the next Turn.

### Item-First Visibility

Any meaningful state transition should be derivable from Items. UI views may
project state, but the projection must not become a second source of truth.

### Familiar, Not IDE-Like

The UX target borrows the clarity and compactness of Codex App, T3 Code, and
Traycer. It should feel like an agent control surface. It should not feel like
a code editor wrapped around a terminal wrapped around a diff engine.

## Short-Term User Experience

### Primary Surface

The first ZenX experience should center on a small set of flows:

1. Connect the user to the subscription-backed provider path.
2. Choose or switch Projects through a single Project switcher.
3. Create or resume Threads through a single Thread sidebar.
4. Create or run from a prompt-first entry point.
5. Pick provider, account, and model before execution when needed.
6. Watch the Turn stream and settle into a durable Thread history.
7. Resume the same Thread after reload or restart without losing server-owned
   history.

Short-term UX acceptance:

- one Project switcher
- one Thread sidebar
- prompt-first create/run
- provider/account/model picker
- no mandatory Project name when the folder path already supplies identity
- no source editor pane
- no file tree as the central organizing element
- no diff review workflow as the default interaction

### Minimum Interaction Model

- Left side: Project and Thread navigation.
- Main surface: active Thread timeline and live Turn execution.
- Secondary surface: concise state, account, and execution metadata.
- No source editor pane.
- No file tree as the central organizing element.
- No diff review workflow as the default interaction.

### CLI/TUI Parity

Zen CLI/TUI should expose the same domain actions, but remain thin clients:

- list and open Projects
- list and open Threads
- create and resume Turns
- inspect server-owned Thread history
- observe execution status

The CLI/TUI must not become a second domain model.

## Provider Slice

The first provider slice must do three things:

1. Use the official Codex app-server route for ChatGPT subscription-backed
   access.
2. Use the stateful Responses/WebSocket upstream for execution and streaming.
3. Prevent any direct provider bypass path from the client or adapter layer.

This means the product can show a working end-to-end session without teaching
clients how to talk to providers directly.

## Phased Plan

### Phase 1: Short-Term Vertical Slice

- Single-account access path.
- Zen App Server owns Projects, Threads, Turns, and history.
- ZenX desktop/web can create, open, and resume Threads.
- A Turn can be submitted and streamed to completion.
- The resulting history is durable and reload-safe.
- The provider path uses the official Codex app-server integration.
- Project root identity is immutable after creation.
- Model, permission, and execution policy updates are persisted as one atomic
  change and applied on the next Turn.
- `maxActiveExecutions` is the single active-execution limit. Each actively
  executing Turn holds one lease for its Agent Executor; waiting logical
  Threads hold none.

### Phase 2: Client Parity

- Zen CLI/TUI speaks the same App Server contract.
- CLI/TUI and ZenX can observe the same durable Thread state.
- The product behavior does not fork by surface.
- Agent-created threads and messages continue to use the same request, persist,
  idempotency, and permission path as UI actions.

### Phase 3: Protocol Readiness

- Event-oriented server updates become explicit.
- Thread and Turn state changes are exposed as a stable event stream.
- The system is ready for richer client synchronization patterns.

### Phase 4: Future Expansion

- Remote pairing.
- Multi-account.
- IM channel gateway.
- More provider routing without client bypass.

## Acceptance Criteria

- A user can connect once and use ZenX to create or resume a Project and
  Thread.
- A Thread remains durable after reload and restart.
- A Turn is scheduled by the server and not treated as an always-running
  session.
- Project root remains immutable after creation, including when the Project
  was derived from a folder path.
- Policy changes land atomically and only affect the next Turn.
- `maxActiveExecutions` counts leases held by actively executing Turns for
  their Agent Executors, not waiting logical Threads or request throughput.
- The same Thread history is visible after the client reconnects.
- The provider slice works through the official Codex app-server path and does
  not require direct provider SDK access in the client.
- Zen CLI/TUI can be added against the same server contract without introducing
  a separate Thread store.
- The UI stays focused on Projects and Threads and does not drift into an IDE
  layout.
- Provider/account/model selection is visible in the short-term UI.
- The create/run flow does not require a manual Project name when the folder
  path already provides it.

## Open Questions

- What is the minimum account model for the first release: one signed-in user,
  one workspace, or one subscription-bound identity?
- How much account state belongs in the Zen App Server versus the upstream
  provider session?
- Which server events must be surfaced in the first client version versus kept
  internal?
- How much history should the short-term UI show by default: full timeline,
  recent Turns only, or a mixed view?
- What is the smallest usable Project setup flow for the first vertical slice?
- Should CLI/TUI ship in the same milestone as ZenX desktop/web, or follow as a
  thin-client parity release?
