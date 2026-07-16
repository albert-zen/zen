# PRD: Long-Term Optimization

## Program Authority

- The manager owns all architecture and issue decisions.
- Workers implement one issue only.
- Linear is not used for this program. The canonical issue state and notes are
  repo-local in
  [`docs/implementation/long-term-optimization-tracker.md`](../implementation/long-term-optimization-tracker.md).
- The issue DAG is
  [`docs/implementation/long-term-optimization-dag.md`](../implementation/long-term-optimization-dag.md).

## Program Constraints

- No backward compatibility is required for public interfaces, protocol, or old
  thread snapshot format.
- Every implementation issue is AFK and uses `manager-strict-loop`.
- Breaking changes are allowed for every issue.
- Every implementation issue uses tracer-bullet TDD where a behavior seam
  exists.
- In every issue, the original worker implements; a fresh-context reviewer
  reviews without edits; findings return to the original worker; a brand-new
  reviewer reviews the fix; this repeats until no blocking or reasonable
  non-blocking suggestions remain.
- Reviewer findings and worker rounds are append-only in a dedicated per-issue
  evidence document named
  `docs/implementation/long-term-optimization-<NNN>-evidence.md`.
- Final program review uses two clean reviewers in parallel, Standards and Spec.

## Target Architecture

1. ItemList remains the only source of truth. Turn/thread snapshots are
   projections from lifecycle Items; no parallel mutable Turn truth.
2. Same-thread turns use server-owned FIFO scheduling with one active turn;
   different threads may execute concurrently. Queue/start/terminal facts are
   Items.
3. Persistence is a per-thread append-only JSONL ThreadJournal. Each Item is
   serialized once. Stream writes are queued per thread; terminal lifecycle
   notifications require successful flush. Journal failures are sticky,
   explicit, and never ignored.
4. HTTP request and SSE transport require an unguessable capability token.
   Wildcard CORS and direct cross-origin browser access are removed. Default
   binding remains loopback. The trusted same-origin Web proxy injects the
   token.
5. Every real shell call requires explicit approval by default. Approval
   request/resolution are first-class Items. Decisions are only `approveOnce`
   or `decline`; turn interrupt cancels pending approval. AppServer owns broker
   resolution. Both Web and TUI expose decisions.
6. A shared incremental interaction/timeline projection serves Web and TUI.
   Ordered append is O(1) amortized; out-of-order or replacement facts remain
   correct. Web client owns exactly one server subscription and React consumes
   a stable external-store interface.
7. Keep one package/repo, but establish kernel, product runtime, Node adapter,
   presentation, and TUI module groups. Root `zen-kernel` entry exports kernel
   only; product/adapters use explicit subpath entrypoints. Acceptance harness
   leaves production `src`.
8. Canonical local quality gate becomes `npm run check`. Add format/lint, core
   and Web typechecks, unit/integration tests, both builds, coverage for
   kernel/product/presentation, and Playwright browser workflow. No GitHub CI is
   required until a remote exists.

## Execution Waves

- Wave 1: 001 + 002 in parallel, then integrate and run full current gates.
- Wave 2: 003.
- Wave 3: 004 + 005 in parallel, then integrate and run full current gates plus
  new targeted checks.
- Wave 4: 006.
- Wave 5: 007.
- Final: two fresh reviewers in parallel (Standards and Spec), fix loop via
  owning workers/integration worker, then full `npm run check`.
