# Zen Agent App PRD

## Problem

Zen has an item-first agent kernel, but users cannot yet coordinate durable work
across projects, threads, and replaceable agent executors. The Agent App adds a
web-first control plane without turning Zen into an IDE.

## Goals

- Organize durable work by Project and Thread.
- Treat a Thread as a persistent work and context container; an Agent is a
  replaceable executor lease for work in that thread.
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
- Agent executor: holds a time-bounded lease to execute a thread and uses
  approved thread tools to coordinate follow-up work.

## Core Workflows

1. Create a Project with a root boundary and policy, then open its thread list.
2. Create or resume a Thread, submit a task, and observe its Item-derived
   timeline and agent lease state.
3. An agent creates a child thread or sends a peer message when Project policy
   permits it; the action and its causal source are recorded as Items.
4. An operator reviews the resulting work through a review-loop thread, then
   archives completed Threads or the Project while preserving history.
5. After a restart, durable Project and Thread state is recovered and pending
   work is reconciled according to explicit recovery policy.

## Domain Terms

- **Project**: permission, resource, and directory boundary containing Threads.
  It has identity, status, root path, policy, and durable metadata.
- **Thread**: persistent unit of work and context. It survives executor changes
  and owns its item history.
- **Agent**: replaceable executor leased to a Thread. An agent is not the
  durable owner of the Thread or its facts.
- **Message**: a typed Item representing user, agent, or coordination content;
  it is not a second message store.
- **Item**: the sole execution and coordination fact. Items may reference a
  parent or cause Item to make cross-thread and Project causality inspectable.

## Agent Coordination And Review

Agents may eventually create child Threads, communicate through a Thread
mailbox, wait on other work, cancel, archive, and hand off execution. Delivery
is turn-boundary by default; an explicit interrupt is required to preempt an
active turn. Review loops are normal Threads with Item-linked requests,
findings, and resolutions, not a separate review event ledger.

## Permissions, Budgets, And Recovery

Project policy constrains concurrent agents, thread depth, model profile, and
whether agents can create threads or message peers. Later resource policy adds
capability grants and budgets without moving authority into Electron. Durable
records validate on load and fail closed on corruption. Recovery reconciles
interrupted leases using Items and never invents parallel runtime state.

## Acceptance

- Projects can be created, listed, read, updated, and archived durably within a
  validated root boundary.
- Duplicate canonical roots are rejected by the host path adapter.
- AppServer is the only business-domain protocol boundary for Web and Electron.
- Project and thread coordination behavior remains Item-derived and causally
  inspectable.
- The UI is Project/Thread-centered and exposes no IDE or source-control
  workbench workflow.
