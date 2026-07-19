# Zen Agent App PRD

## Problem

Zen has an item-first agent kernel, but users cannot yet coordinate durable work
across projects, threads, and replaceable agent executors. The Agent App adds a
web-first control plane without turning Zen into an IDE.

## Goals

- Organize durable work by Project and Thread.
- Treat a Thread as a durable logical conversation that consumes no execution
  resources while idle. A Turn is durable work; an Agent Executor is created
  only while a scheduled Turn is actively running.
- Keep Item as the sole runtime fact. Project coordination and thread execution
  facts are Items with causal links; views and protocol data are projections.
- Let agents eventually create, list, read, send to, wait for, cancel, archive,
  and hand off threads through explicit tools.
- Deliver the product on the web first, then host the same AppServer protocol in
  a thin Electron shell.

## Non-Goals

- Interactive terminal.
- File tree or editor.
- Manual diff accept or revert flow.
- Source-control workbench.
- Electron IPC carrying product-domain decisions.

## Personas

- Project owner: scopes a project to a workspace root, resource policy, and
  durable work threads.
- Operator: starts, observes, routes, interrupts, and resumes agent work.
- Agent executor: a short-lived runtime that executes one scheduled Turn under
  an immutable policy snapshot and then terminates or yields.

## Core Workflows

1. Create a Project with a root boundary and policy, then open its thread list.
2. Create or resume a Thread, durably submit a Turn/Command, and observe its
   Item-derived timeline and scheduled execution state.
3. An agent creates a child thread or sends a peer message when Project policy
   permits it; the action and its causal source are recorded as Items.
4. An operator reviews the resulting work through a review-loop thread, then
   archives completed Threads or the Project while preserving history.
5. After a restart, durable Project and Thread state is recovered and pending
   work is reconciled according to explicit recovery policy.

## Domain Terms

- **Project**: permission, resource, and directory boundary containing Threads.
  It has identity, status, root path, policy, and durable metadata.
- **Thread**: persistent logical conversation and context. It owns durable Item
  history but no resident process, executor, or scheduler slot.
- **Turn/Command**: durable requested work in a Thread. It is persisted before
  scheduling and may remain queued without creating an Agent Executor.
- **Agent Executor**: replaceable, short-lived executor for one active Turn. It
  is not the durable owner of the Thread or its facts.
- **Message**: a typed Item representing user, agent, or coordination content;
  it is not a second message store.
- **Item**: the sole execution and coordination fact. Items may reference a
  parent or cause Item to make cross-thread and Project causality inspectable.

## Agent Coordination And Review

UI and Agent callers use the same App Server commands to create child Threads,
send to a specific Thread, wait, cancel, archive, and hand off. The App Server
applies one authorization, idempotency, persistence, and scheduling path; an
Agent has no internal coordinator bypass. Wait is a durable dependency: the
current Turn yields its executor slot, and a durable wake schedules a new
continuation Turn. Review loops are normal Threads with Item-linked requests,
findings, and resolutions, not a separate review event ledger.

## Permissions, Budgets, And Recovery

Project policy constrains active Turn executors, thread depth, model profile, and
whether agents can create threads or message peers. Later resource policy adds
capability grants and budgets without moving authority into Electron. Durable
records validate on load and fail closed on corruption. Recovery reconciles
interrupted executions using Items and never invents parallel runtime state.

Project root is immutable identity. Model, permissions, and execution policy
updates are atomically visible to the next scheduled Turn. An already-active
Turn finishes with the snapshot captured when its executor was granted.

## Acceptance

- Projects can be created, listed, read, updated, and archived durably within a
  validated root boundary.
- Duplicate canonical roots are rejected by the host path adapter.
- AppServer is the only business-domain protocol boundary for Web and Electron.
- Project and thread coordination behavior remains Item-derived and causally
  inspectable.
- One hundred idle Threads create no Agent Executors or active execution slots.
- `maxActiveExecutions` limits active Turn executors while queued Turns remain
  durable, and wait releases its slot before a continuation is scheduled.
- UI and Agent mutations enter the identical durable App Server command path.
- Project root updates are rejected; mutable policy applies to the next Turn.
- The UI is Project/Thread-centered and exposes no IDE or source-control
  workbench workflow.
