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

## Wave 2 Integration Record

Integrated exact reviewed issue-003 head `bc0a83de948e520cce63f6c4f85947e44ecbff8f`
on canonical branch `codex/long-term-optimization` with merge commit
`674dcd29fdc01cf261d90501fd45ef63023ed8ac` (parents
`de54364c600ac97882ca53837269cfe2e3426348` and
`bc0a83de948e520cce63f6c4f85947e44ecbff8f`). No conflicts occurred.

| Gate | Result |
| --- | --- |
| `npm test -- --maxWorkers=1` | PASS; 31 files, 195 tests |
| `npm run typecheck` | PASS |
| `npm run typecheck:web` | PASS |
| `npm run build` | PASS |
| `npm run web:build` | PASS; 1,750 modules transformed |
| `git diff --check` | PASS |

## Wave 3 Issue-004 Integration Record

Integrated reviewed issue-004 head `0a27953e64f8913a4e5362618ee7f0122fe2c712`
from `codex/long-term-optimization-004` into canonical
`codex/long-term-optimization` with merge commit
`d238643224039f5f1447364cfa178536bea0de93`. The merge was `--no-ff` and had
no conflicts. Canonical issues 001-003 were preserved. Issue 004 is now
`Integrated`; issue 005 remains in `Agent Review`, so Wave 3 is not complete.

| Gate | Result |
| --- | --- |
| `npm test` (single serialized run) | INCOMPLETE; 30/31 files and 201/202 tests passed; `test/web-dev-proxy.test.ts` DEBUG subprocess case failed with transient `ECONNREFUSED` on `127.0.0.1:53931` |
| `npx vitest run test/web-dev-proxy.test.ts --reporter=verbose` | PASS; 1 file, 4/4 tests |
| `npm run typecheck` | PASS |
| `npm run typecheck:web` | PASS |
| `npm run build` | PASS |
| `npm run web:build` | PASS; 1,750 modules transformed |
| `git diff --check` | PASS |

Residual risk: the required full suite has one non-reproducible Web proxy
subprocess failure in the recorded run; the focused rerun passed. No source
change was made because the failure did not reproduce and no merge regression
was identified.

## Wave 3 Issue-005 Integration Record

Integrated exact reviewed issue-005 head
`8654cf10b2bc0b7a884ca5105a4a8487740f4dfc` from
`codex/long-term-optimization-005` into canonical
`codex/long-term-optimization` with no-fast-forward merge commit
`989d56b2b464a74e2f166d37eb305082972c871d` (parents
`5d7636ed14e3f741d1daf23267e250ba846da7ba` and
`8654cf10b2bc0b7a884ca5105a4a8487740f4dfc`). The only merge conflict was the
canonical tracker. The resolution retains 004 as Integrated, marks 005 as
Integrated at its exact reviewed head, completes Wave 3, and makes 006 Ready.

The merge auto-combined `src/index.ts`: 004 ThreadJournal/protocol/provider/
AppServer exports and 005 projection/client exports are all retained. 004
persistence coverage and 005 incremental projection, lifecycle, jsdom,
lockfile, and test changes are retained. Core typechecking then found one
test-fixture contract mismatch: the 005 deferred session client omitted 004's
required `thread/list.result.persistenceFailures`. The focused test-only commit
`6b1ea5c1e87c713f16a2cd54d6e236d0a135d5f7` supplies `[]`; it makes no
production behavior change. This is the verified integrated code revision.

| Command | Exit | Result |
| --- | ---: | --- |
| `npm install` | 0 | Workspace synchronized for reviewed jsdom lockfile dependency; 116 packages added, audit reported 0 vulnerabilities. |
| Initial `npm test` | 0 | 32 files passed; 218/218 tests passed. |
| Initial `npm run typecheck` | 1 | Found the missing `persistenceFailures` test-fixture field described above. |
| `npm test -- test/agent-interaction-session.test.ts` | 0 | Focused integration contract test: 1 file, 10/10 tests passed. |
| Final `npm test` (single serialized run) | 0 | 32 files passed; 218/218 tests passed. |
| Final `npm run typecheck` | 0 | Core `tsc --noEmit` passed. |
| `npm run typecheck:web` | 0 | Web `tsc -p web/tsconfig.json --noEmit` passed. |
| `npm run build` | 0 | Node declaration/JavaScript build passed. |
| `npm run web:build` | 0 | Vite production build passed; 1,750 modules transformed. |
| `git diff --check` | 0 | No working-tree whitespace errors. |

The known Web development proxy `ECONNREFUSED` did not occur during the final
serialized run, so its targeted recovery path was not needed. Infrastructure
redesign remains deferred to issue 007. No GitHub handoff runs because this
repository remains in local-branch mode without a canonical remote.

## Wave 4 Issue-006 Integration Record

Integrated exact reviewed issue-006 head
`b62873bd3aa216f56d870c072f651ab2dbcd074a` from
`codex/long-term-optimization-006` into canonical
`codex/long-term-optimization` with no-fast-forward merge commit
`0fd30da99ac2ad0f506e456ec66cecd2eb736313` (parents
`00a87a5fa1a6ac1751e459b046455785647b2e79` and
`b62873bd3aa216f56d870c072f651ab2dbcd074a`). No conflicts occurred; all
001-005 behavior and evidence remain in the first parent, and the reviewed
006 topology is present in the second parent. The package-lock bin-path sync
was committed separately as `1b19823`.

| Gate | Exit | Result |
| --- | ---: | --- |
| `npm install --package-lock-only --ignore-scripts` | 0 | Up to date; 0 vulnerabilities; bin paths synchronized in separate commit |
| `npm test -- --maxWorkers=1` | 0 | 33 files passed; 222/222 tests passed |
| `npm run typecheck` | 0 | Core TypeScript check passed |
| `npm run typecheck:web` | 0 | Web TypeScript check passed |
| `npm run build` | 0 | Production Node declaration/JavaScript build passed |
| `npm run build:acceptance` | 0 | Acceptance build passed |
| `npm run web:build` | 0 | Vite production build passed; 1,752 modules transformed |
| Package root/subpath runtime smoke | 0 | `zen-kernel`, `/product`, `/node`, `/presentation`, `/tui` imported successfully |
| Package declaration smoke | 0 | Five published declaration entrypoints present |
| Noninteractive CLI smoke | 0 | `dist/tui/cli.js` handled `/help` and `/exit` |
| `git diff --check` | 0 | Passed |

The unchanged TUI timing flake did not recur in this integration run; no test
redesign was made. Provider-backed live behavior remains environment-dependent,
and browser automation plus release-quality aggregate gates remain deferred to
007. Canonical status after integration: 006 `Integrated`, Wave 4 `Complete`,
007 `Ready`.
