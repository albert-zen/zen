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
| APP-009  | Complete | Final serialized check, coverage, real HTTP/SSE E2E, desktop package smoke, audit, and hygiene gates passed locally. |
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

## Codex Worker Note

Round: APP-009 final-gate handoff

- APP-009 remains In Progress. The first full `npm run check` reached Playwright
  and found an invalid locator assertion API; the assertion was corrected. The
  next full check passed formatting, lint, all TypeScript checks, `49` test files
  / `401` tests, and all builds, then timed out in the existing
  `LocalToolRuntime` shell test during kernel coverage. The timeout was not
  widened or skipped.
- Standalone serial kernel coverage immediately passed `49` files / `401` tests,
  so the failure is not yet proven deterministic. It is nevertheless a failed
  final gate and prevents APP-009 completion and any commit.
- The exact worktree test-app-data directory `.zen` was verified and removed.
  No process termination was performed; the external attributable
  Node/Electron/Zen Agent census is zero.

## Codex Worker Note

Round: APP-009 completion

- The normal shell-result path no longer serializes a global Windows process
  table during owned-process quiescence. It retains two independent snapshots
  and exact identity/parent-chain checks, scoped to the captured ownership tree
  and direct descendants.
- Kernel coverage passed three serial repetitions (`49` files / `401` tests)
  with zero test-owned process and `zen-agent-app-*` temporary-root residue.
  The single subsequent full `npm run check` exited `0`: formatting, lint,
  main/Web/desktop types, tests, builds, kernel/product/presentation coverage,
  and three real HTTP/SSE E2E workflows passed. `npm audit` reported zero
  vulnerabilities.
- APP-009 is Complete; APP-010 remains Pending. The verified worktree `.zen`
  test app-data directory was removed, no broad cleanup or arbitrary process
  termination was used, and final attributable Node/Electron/Zen Agent census
  is zero.
