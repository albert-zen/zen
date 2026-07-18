# Zen Agent App Architecture

## Deployment And Boundaries

The product is Web-first. The Web UI speaks AppServer project/thread protocol;
an eventual Electron shell hosts the same web surface and contributes only
window, lifecycle, and platform integration. Electron IPC must not contain
domain logic.

```text
Web UI / Electron thin shell
  -> AppServer protocol
    -> product: ProjectCoordinator, ThreadMailbox, AgentScheduler
      -> kernel: ItemList, AgentLoop
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

## Thread Inbox

`ThreadMailbox` is a future product seam. Message delivery is idempotent by
message identity and becomes visible at a turn boundary by default. An explicit
interrupt may preempt the current turn. Both enqueue and delivery results are
Items linked to their cause; a mailbox has no independent message store.

## Scheduler And Wait Graph

`AgentScheduler` will grant replaceable executor leases under Project policy.
It records scheduling, waiting, cancellation, and lease recovery as Items. A
wait graph detects dependency cycles and enforces configured thread depth and
concurrency. Scheduler ownership is product-level; the kernel remains unaware
of projects and leases.

## UI Information Architecture

The main surface is a Project navigator, Thread list, and selected
Item-derived timeline with work controls. Policy, resource usage, recoverable
leases, and review-loop status are contextual project/thread panels. There is
no editor, file tree, interactive terminal, manual diff workflow, or source
control workbench.
