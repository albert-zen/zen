# Long-Term Optimization Wave 1 Review

Review artifact convention:
[`docs/agents/artifact-paths.md`](../agents/artifact-paths.md)

Canonical branch: `codex/long-term-optimization`

Verified code revision:
`47304b2168cb8048fe7e57fad596d509a726afe2`

Evidence publication: the exact docs-only evidence commit is recorded in the
append-only Publication Ledger after this report's initial commit.

Backup ref:
`refs/backup/codex-long-term-optimization-wave1-pre-standards-rework-20260716`
at `984151d423192438732b03619fd22191aa8512c5`.

## Codex Review Note

Round: 1
Review scope: Wave 1 integration of long-term-optimization-001 and
long-term-optimization-002
Reviewer context: fresh Wave 1 Standards and Spec reviews launched by manager
Reviewer edits: none
Reviewed branch: `codex/long-term-optimization` at
`984151d423192438732b03619fd22191aa8512c5`
Base revision/diff scope:
`05477f7b54829a10d9fd79e18ca9e5247f1bd418..984151d423192438732b03619fd22191aa8512c5`
Standards Review blocking: REWORK - canonical commits
`65ac805b8e9acccbab3e44fa33e3c61ba78b6d71` and
`819e9e151c7add2dad00215556f7b4a3c1852588` had empty bodies despite
non-obvious security and race decisions; durable exact-head Wave 1 integration
evidence was also missing.
Standards Review non-blocking: none reported
Standards Review missing evidence: exact integrated revision, command results
and counts, skipped-gate rationale, changed-module summary, and durable output
location
Spec Review blocking: none - STRICT PASS
Spec Review non-blocking: none reported
Spec Review missing evidence: none reported
Local review state decision: Rework
State decision reason: product behavior and specification passed; bounded
history and evidence corrections were returned to the original integration
worker.

## Canonical History Correction Ledger

Only the canonical optimization branch was rewritten. The issue 002 reviewed
commits remain unchanged because they are not descendants of the reworded issue
001 commits.

| Prior hash | Canonical hash | Subject |
| --- | --- | --- |
| `65ac805b8e9acccbab3e44fa33e3c61ba78b6d71` | `e05045d6acf5a198470b882c57349baff81f2d7e` | `fix: harden capability transport handoff` |
| `819e9e151c7add2dad00215556f7b4a3c1852588` | `8d8f962c2b40767449dade032865c6ffc9f34a44` | `fix: close transport capability races` |
| `a84f6872eb2cf41e1020ee8de3f88ea05c5d2fc3` | `99a2a7cd184f0d13d4a5d0e673b41888024c9945` | `docs: record optimization 001 review pass` |
| `b00ce7e374a54a42abbee0b8861fb16b1606f022` | `3d6754c835fd56c000d306f0f65d4c1f28154edf` | `chore: integrate long-term optimization 001` |
| `3ce9250357ea5051e1f9e2fba4a6c449be3b81e8` | `b2e721e19bbd185a6546bb08aab6dc42f89d3b11` | `chore: integrate long-term optimization 002` |
| `984151d423192438732b03619fd22191aa8512c5` | `47304b2168cb8048fe7e57fad596d509a726afe2` | `docs: complete wave 1 integration` |

For every row, the old and new commit tree IDs are identical and the raw
author/committer lines are identical. Unreworded descendants retain their
original messages. The old and new pre-doc integrated heads both use tree
`d97bb2af79c7101e2b59d2b8ca7a509bab53ec14`; `git diff --quiet` returned 0.

## Changed Modules

- Transport/security: App Server transport, config and CLI; Web dev CLI,
  client, Vite proxy and workspace; dogfood caller; corresponding transport,
  proxy, config, CLI, static and client tests.
- Item-derived lifecycle/FIFO: AgentLoop, App Server protocol, ThreadManager,
  interaction/session expectations and lifecycle/protocol/server tests.
- Durable records: README, issue 001/002 evidence, canonical tracker, and the
  retired ALB-93 smoke harness.
- Corrective rework itself changes no production or test tree content. It adds
  commit bodies and durable documentation only.

## Exact-Head Verification

All commands below ran on exact code revision
`47304b2168cb8048fe7e57fad596d509a726afe2` before any evidence files were
edited.

| Command | Exit | Result |
| --- | ---: | --- |
| `git rev-parse HEAD` | 0 | `47304b2168cb8048fe7e57fad596d509a726afe2` |
| `npm test -- test/app-server-transport.test.ts` | 0 | 1 file passed; 13/13 tests passed. |
| `npm run typecheck` | 0 | Core `tsc --noEmit` passed. |
| `npm run typecheck:web` | 0 | Web `tsc -p web/tsconfig.json --noEmit` passed. |
| `npm test` | 0 | 29 files passed; 189/189 tests passed. |
| `npm run build` | 0 | Node declaration/JavaScript build passed. |
| `npm run web:build` | 0 | Vite production build passed; 1,750 modules transformed. |
| `git diff --check` | 0 | No working-tree whitespace errors. |
| `git diff --check 05477f7b54829a10d9fd79e18ca9e5247f1bd418..HEAD` | 0 | No full integration-range whitespace errors. |

Concise command output and counts are retained in this review report. Raw
console streams were not persisted separately; no additional log artifact was
required by the repository artifact convention.

## Skipped Gates

- Format and lint: skipped because neither gate is configured in the current
  scaffold.
- Dedicated integration and E2E/browser commands: skipped because they are not
  configured; browser automation is assigned to issue 007. Integration
  behavior is covered by the Vitest suites above.
- `npm run check`: skipped because issue 007 owns creation of that aggregate
  command and it does not exist yet.
- GitHub/remote checks: skipped because this program remains in local-branch
  mode with no canonical remote.

## Codex Worker Note

Round: 1
Issue: Wave 1 integration Standards rework
Local review state transition: Rework -> Agent Review
Branch: `codex/long-term-optimization`
PR URL: not configured; local-branch mode
Base revision/diff scope: backup head
`984151d423192438732b03619fd22191aa8512c5` to verified rewritten code head
`47304b2168cb8048fe7e57fad596d509a726afe2`, followed only by durable evidence
documentation
Summary of behavior delivered: no product behavior changed; reworded two
security/race commits with Why/What/Evidence bodies, preserved trees and
authorship, added old-to-new correction ledgers, and recorded exact-head gates.
Final scope summary: process/evidence correction only; no production or test
source edits
Changed files/modules: commit metadata plus
`docs/implementation/long-term-optimization-001-evidence.md`,
`docs/implementation/long-term-optimization-review.md`, and
`docs/implementation/long-term-optimization-tracker.md`
Tests added/updated: none
Acceptance criteria status: PASS - backup ref exists; PASS - required bodies
exist; PASS - all affected trees and metadata match; PASS - durable hash mapping
exists; PASS - exact-head gates are green; PASS - Spec remains STRICT PASS;
PENDING - Standards axis requires a new reviewer
Commands run and results: exact-head command table above; all required commands
exit 0
Validation log paths:
`docs/implementation/long-term-optimization-review.md`
Required check status or local-check handoff reason: all currently configured
local checks pass; unconfigured gates are listed above
Evidence links/paths:
`docs/implementation/long-term-optimization-review.md` and
`docs/implementation/long-term-optimization-001-evidence.md`
Decisions made: use append-only correction ledgers rather than changing prior
issue notes; retain issue 002 hashes; retain a local backup ref
Standards notes: corrective findings addressed; Standards is not marked passed
Reviewer notes: assign a new Standards reviewer against the canonical branch;
the manager-reported Spec result is STRICT PASS
Open questions: none
Known residual risks: local-only history rewrite requires consumers of old
hashes to use the mapping ledger; browser automation remains deferred to issue
007
Blocker or context escalation details: none

## Evidence Publication Ledger

Verified code revision:
`47304b2168cb8048fe7e57fad596d509a726afe2`

Primary evidence-only commit:
`c01883a3fcb82c15cce1c4d45166f6510e80b1fd`

The primary evidence commit is the direct child of the verified code revision
and changes only the three durable documentation artifacts named in the Worker
Note. This append-only ledger is a docs-only successor because a commit cannot
contain its own final object ID.

## Codex Review Note

Round: 2
Review scope: Wave 1 corrective Standards review
Reviewer context: fresh
Reviewer edits: none
Reviewed branch: `codex/long-term-optimization` at
`f35bc7935e89d4b202f32e293508049672406218`
Base revision/diff scope:
`47304b2168cb8048fe7e57fad596d509a726afe2..f35bc7935e89d4b202f32e293508049672406218`
Standards Review blocking: none - STRICT PASS
Standards Review non-blocking: none
Standards Review missing evidence: none
Spec Review blocking: none - prior STRICT PASS remains authoritative
Spec Review non-blocking: none
Spec Review missing evidence: none
Local review state decision: Complete
State decision reason: The fresh corrective reviewer verified substantive
commit bodies, durable exact-head evidence, append-only correction ledgers,
identical old/new mapped trees, and a clean canonical branch. Both Wave 1
review axes now pass.
