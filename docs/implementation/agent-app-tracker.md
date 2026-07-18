# Agent App Tracker

No Linear mutation is performed for this local wave.

| ID       | State    | Notes                                                                                                          |
| -------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| APP-001  | Complete | PRD, architecture, DAG, tracker, and evidence committed locally.                                               |
| APP-002  | Complete | Project aggregate, memory registry, and atomic JSON registry committed locally.                                |
| APP-003  | Complete | Coordination envelope, durable journal, mailbox, and projection committed locally.                             |
| APP-004  | Complete | FIFO leases, event-driven wait graph, and provider-neutral thread tools committed locally.                     |
| APP-005  | Complete | 005A/B/005C now expose only the project-scoped Agent App remote protocol.                                      |
| APP-005B | Complete | Shared HTTP/SSE transport adapter, Node project runtime factory, and production composition committed locally. |
| APP-005C | Complete | Migrated public client/transport, web bootstrap/demo, and production CLI composition to Agent App.             |
| APP-006  | Complete | Project/thread control-plane UI and presentation projection committed locally.                                 |
| APP-007  | Complete | Thin Electron desktop shell, same-origin static host, and bounded platform bridge committed locally.           |
| APP-008  | Complete | Trusted capability context, bounded resource policy, recovery facts, and input hardening completed locally.   |
| APP-009  | Pending  | Depends on all implementation work.                                                                            |
| APP-010  | Pending  | Global review/remediation after APP-009.                                                                       |

## State Discipline

Local states mirror the repository workflow: Pending, In Progress, Complete,
Blocked. Worker progress is retained in this append-only artifact while Linear
is intentionally untouched. APP-010 is the only planned review gate for this
wave.

## APP-005C Migration Repair

- The APP-006 known test-contract gap is resolved: all 32 browser transport and
  Web UI client tests now exercise the project-scoped Agent App protocol.
- APP-005, APP-005C, and APP-006 remain Complete. This repair changes no APP-006
  visual behavior and does not advance APP-007.
