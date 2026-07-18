# Agent App Tracker

No Linear mutation is performed for this local wave.

| ID       | State       | Notes                                                                                                          |
| -------- | ----------- | -------------------------------------------------------------------------------------------------------------- |
| APP-001  | Complete    | PRD, architecture, DAG, tracker, and evidence committed locally.                                               |
| APP-002  | Complete    | Project aggregate, memory registry, and atomic JSON registry committed locally.                                |
| APP-003  | Complete    | Coordination envelope, durable journal, mailbox, and projection committed locally.                             |
| APP-004  | Complete    | FIFO leases, event-driven wait graph, and provider-neutral thread tools committed locally.                     |
| APP-005  | In Progress | 005A protocol/runtime server and 005B transport/composition are complete; 005C migration remains.              |
| APP-005B | Complete    | Shared HTTP/SSE transport adapter, Node project runtime factory, and production composition committed locally. |
| APP-005C | Pending     | Migrate legacy public route and consumers to the Agent App endpoint.                                           |
| APP-006  | Pending     | Depends on APP-005.                                                                                            |
| APP-007  | Pending     | Depends on APP-006.                                                                                            |
| APP-008  | Pending     | Cross-cutting after coordination/UI work.                                                                      |
| APP-009  | Pending     | Depends on all implementation work.                                                                            |
| APP-010  | Pending     | Global review/remediation after APP-009.                                                                       |

## State Discipline

Local states mirror the repository workflow: Pending, In Progress, Complete,
Blocked. Worker progress is retained in this append-only artifact while Linear
is intentionally untouched. APP-010 is the only planned review gate for this
wave.
