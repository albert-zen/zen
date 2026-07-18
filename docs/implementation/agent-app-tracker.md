# Agent App Tracker

No Linear mutation is performed for this local wave.

| ID | State | Notes |
| --- | --- | --- |
| APP-001 | Complete | PRD, architecture, DAG, tracker, and evidence committed locally. |
| APP-002 | In Progress | Project aggregate and JSON registry. |
| APP-003 | Pending | Depends on APP-002. |
| APP-004 | Pending | Depends on APP-003. |
| APP-005 | Pending | Depends on APP-002 through APP-004. |
| APP-006 | Pending | Depends on APP-005. |
| APP-007 | Pending | Depends on APP-006. |
| APP-008 | Pending | Cross-cutting after coordination/UI work. |
| APP-009 | Pending | Depends on all implementation work. |
| APP-010 | Pending | Global review/remediation after APP-009. |

## State Discipline

Local states mirror the repository workflow: Pending, In Progress, Complete,
Blocked. Worker progress is retained in this append-only artifact while Linear
is intentionally untouched. APP-010 is the only planned review gate for this
wave.
