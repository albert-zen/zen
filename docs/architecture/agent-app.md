# Zen Agent App Architecture

## Deployment And Boundaries

The product is Web-first. The Web UI speaks AppServer project/thread protocol;
an eventual Electron shell hosts the same web surface and contributes only
window, lifecycle, and platform integration. Electron IPC must not contain
domain logic.

```text
Web UI / Electron thin shell
  -> AppServer protocol
    -> durable Project/Thread Command pipeline
      -> product: ProjectCoordinator, AgentScheduler
        -> short-lived Turn Agent Executor -> kernel: ItemList, AgentLoop
    -> node adapters: project registry, journals, host capabilities
```

`product` does not access the filesystem. Node persistence and Windows root
canonicalization are adapters. ThreadManager depends on product contracts, not
on any Node implementation.

## Item Causality Model

`ItemList` remains the source of truth. A coordination request, mailbox
delivery, scheduler state change, executor lease, review finding, and recovery
action each append an Item. Item `parentId` and `causeId` connect Project-level
coordination to thread-level execution. Messages, events, and traces are
derived projections only.

## Durability

Project metadata is stored in one explicitly configured app-data JSON file.
The Node adapter validates the versioned schema, writes a temporary sibling,
and atomically renames it. Corrupt files fail closed. Writes serialize, and a
ProjectManager publishes an in-memory mutation only after durable save
succeeds. No adapter scans arbitrary workspace directories.

Thread history continues to use its explicit journal seam. Project persistence
and thread journaling remain separate because their retention and replay needs
are different.

Every remotely initiated mutation is first recorded in a durable command/result
projection keyed by scope, method, and idempotency key. A completed command
replays its exact result. A command found pending after process loss reports that
state and is never executed a second time without method-specific reconciliation.
Thread-tool commands additionally use resumable coordination facts because they
do not cross the remote protocol boundary.

Cross-journal references follow a strict barrier: a thread or queued turn is
flushed to its thread journal before a coordination fact may claim it exists or
is activated. Recovery resumes prepared thread commands and fails closed on
unexplained cross-journal references.

## Thread Inbox

`ThreadMailbox` is a future product seam. Message delivery is idempotent by
message identity and becomes visible at a turn boundary by default. An explicit
interrupt may preempt the current turn. Both enqueue and delivery results are
Items linked to their cause; a mailbox has no independent message store.

## Idempotency

Mutating AppServer operations will carry an idempotency key scoped to the
Project and command type. Retrying a completed create, send, handoff, or
delivery returns the durable Item-derived result rather than performing a
second action. Registry writes serialize so retry and recovery paths have a
single durable order.

## Turn Scheduling And Durable Wait

`AgentScheduler` governs simultaneous Turn/Agent Executor instances under the
internal `maxActiveExecutions` policy. It does not count Threads, App Server
requests, or durable queued Turns. A Thread therefore occupies zero execution
slots and creates zero executor processes while idle.

Every message is first persisted as a Turn/Command. Only after the thread
journal barrier may the scheduler grant a short-lived lease for that Turn and
instantiate its Agent Executor. Completion, failure, cancellation, archive, and
recovery settle or fence that Turn lease. The lease is never owned for the
Thread lifetime.

Wait is durable command dependency state in coordination Items, not a blocked
Executor. Executing `thread.wait` persists the dependency and ends the current
Turn with `waiting`, which releases its scheduler slot. A durable target
terminal fact wakes the dependency by creating and flushing a new continuation
Turn; that continuation competes for a fresh scheduler lease. Recovery rebuilds
the dependency from Items and never restores an in-memory blocked executor.

UI commands and Agent thread tools both enter the exact same App Server request,
authorization, idempotency, command-ledger, journal-barrier, and scheduling
pipeline. Agent tools cannot call ProjectCoordinator or AgentScheduler directly.

## Thread Authority And Archive

Thread relation is transitive. Agent executors may act on descendants and on
policy-authorized peers, but never on direct or transitive ancestors. Human
operator commands remain a separate trusted authority path. Archived threads
retain readable Item history while rejecting all new execution and coordination
mutations; archive first fences queued and active execution, then commits the
archive fact.

## Project Identity And Runtime Updates

A Project root is immutable identity. The Node host stores an absolute real path
with host-appropriate case normalization before collision checks. Mutable model,
permission, and concurrency updates are serialized and atomically replace the
runtime's current Project snapshot. A scheduler grant captures that snapshot for
the new Turn; active Turns keep their existing snapshot, while the next Turn
observes the update. The runtime remains a Project-scoped coordinator, not a
resident Agent per Thread.

## UI Information Architecture

The main surface is a Project navigator, Thread list, and selected
Item-derived timeline with work controls. Policy, resource usage, recoverable
leases, and review-loop status are contextual project/thread panels. There is
no editor, file tree, interactive terminal, manual diff workflow, or source
control workbench.
