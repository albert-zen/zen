# Long-Term Optimization Tracker

PRD: [`docs/prd/long-term-optimization.md`](../prd/long-term-optimization.md)

Issue DAG:
[`docs/implementation/long-term-optimization-dag.md`](long-term-optimization-dag.md)

## Canonical Status

Linear is not used for this program. This Markdown tracker is canonical for
issue state and state transitions. Worker and reviewer notes are repo-local and
append-only in the dedicated per-issue evidence documents.

The manager owns architecture decisions, issue decisions, issue release, and
integration. Workers implement one issue only.

## State Board

| Backlog | Ready | In Progress | Agent Review | Rework | Integrated                                           | Complete          | Blocked |
| ------- | ----- | ----------- | ------------ | ------ | ---------------------------------------------------- | ----------------- | ------- |
| -       | -     | -           | -            | -      | 003<br>004<br>005<br>006<br>007<br>008<br>009<br>010 | 001<br>002<br>011 | -       |

## Issue Register

| Issue                      | State      | Dependencies               | Branch                                                                                       | Worker Round | Review Round | Last Evidence Path                                                          |
| -------------------------- | ---------- | -------------------------- | -------------------------------------------------------------------------------------------- | -----------: | -----------: | --------------------------------------------------------------------------- |
| long-term-optimization-001 | Complete   | none                       | `codex/long-term-optimization-001`                                                           |            3 |            3 | `docs/implementation/long-term-optimization-001-evidence.md`                |
| long-term-optimization-002 | Complete   | none                       | `codex/long-term-optimization-002`                                                           |            4 |            4 | `docs/implementation/long-term-optimization-002-evidence.md`                |
| long-term-optimization-003 | Integrated | 001, 002                   | `codex/long-term-optimization-003 @ bc0a83de948e520cce63f6c4f85947e44ecbff8f`                |            3 |            3 | `docs/implementation/long-term-optimization-003-evidence.md`                |
| long-term-optimization-004 | Integrated | 002, 003                   | `codex/long-term-optimization-004 @ 0a27953e64f8913a4e5362618ee7f0122fe2c712`                |            4 |            4 | `docs/implementation/long-term-optimization-004-evidence.md`                |
| long-term-optimization-005 | Integrated | 002, 003                   | `codex/long-term-optimization-005 @ 8654cf10b2bc0b7a884ca5105a4a8487740f4dfc`                |            6 |            6 | `docs/implementation/long-term-optimization-005-evidence.md`                |
| long-term-optimization-006 | Integrated | 001-005                    | `codex/long-term-optimization-006 @ b62873bd3aa216f56d870c072f651ab2dbcd074a`                |            2 |            2 | `docs/implementation/long-term-optimization-006-evidence.md`                |
| long-term-optimization-007 | Integrated | 006                        | `codex/long-term-optimization-007 @ bf795d40a3669d925eb95933b484290709099e0c`                |           32 |           27 | `docs/implementation/long-term-optimization-007-evidence.md`                |
| long-term-optimization-008 | Integrated | 007                        | `codex/long-term-optimization @ 2df7fef3b09f41c39fb6813f27485482ed708a46`                    |            4 |            3 | `docs/implementation/long-term-optimization-global-remediation-evidence.md` |
| long-term-optimization-009 | Integrated | 008 implementation         | `codex/long-term-optimization @ 2df7fef3b09f41c39fb6813f27485482ed708a46`                    |            4 |            3 | `docs/implementation/long-term-optimization-global-remediation-evidence.md` |
| long-term-optimization-010 | Integrated | 009 resource serialization | `codex/long-term-optimization @ 2df7fef3b09f41c39fb6813f27485482ed708a46`                    |            4 |            3 | `docs/implementation/long-term-optimization-global-remediation-evidence.md` |
| long-term-optimization-011 | Complete   | 008-010                    | `codex/long-term-optimization-global-remediation @ f017ba432b49a71ce06115bd9e5333608433a345` |            1 |            1 | `docs/implementation/long-term-optimization-global-remediation-evidence.md` |

Issues 008, 009, and 010 are `Integrated` in canonical branch
`codex/long-term-optimization` at merge commit
`2df7fef3b09f41c39fb6813f27485482ed708a46`. Their prior strict-pass review
evidence remains at `984d0448ef5843e069ee73bcaf20ea04417d1b20`.

## Global Remediation DAG

The manager-owned final remediation sequence is intentionally serialized on one
worker branch:

```mermaid
flowchart LR
  A["008 Durability before activation"] --> B["009 Lossless snapshot/stream handoff"]
  B --> C["010 Aggregate production shutdown"]
  C --> D["Fresh Standards and Spec review"]
```

The serialized implementation, fresh review, canonical integration, and
manager-owned integration gate are complete. The global remediation wave and
its program are complete. Acceptance criteria and append-only worker and review
notes are recorded in
[`docs/implementation/long-term-optimization-global-remediation-evidence.md`](long-term-optimization-global-remediation-evidence.md).

## ISSUE-011 Test Hygiene Tail

`long-term-optimization-011` provides deterministic cleanup for journal test
fixtures after the integrated 008-010 product work. It changes test
infrastructure only and does not reopen or alter the integrated product
semantics. The manager-recorded canonical hygiene residue placed 011 in
`Rework`; Worker Round 1 and fresh Review Round 1 are complete. ISSUE-011 is
Ready for Integration at `f017ba432b49a71ce06115bd9e5333608433a345` but is
not `Integrated`. Program closeout waits for the manager-owned canonical merge.

## State Transitions

The canonical forward flow is:

`Backlog -> Ready -> In Progress -> Agent Review -> Integrated -> Complete`

The strict review loop is:

`Agent Review -> Rework -> In Progress -> Agent Review`

`Blocked` records a blocking condition from any state. The manager owns the
decision to release an issue from `Backlog`, resolve `Blocked`, integrate a
reviewed issue, and mark it `Complete`.

Each transition must update the State Board and Issue Register in this file.
Each worker or review round must also append its note to that issue's evidence
document. Prior notes are never edited or overwritten.

## Strict Review Loop

Every issue uses `manager-strict-loop`:

1. The original worker implements the issue using tracer-bullet TDD where a
   behavior seam exists.
2. The original worker appends a new `## Codex Worker Note`, updates the worker
   round, and moves the local tracker state to `Agent Review`.
3. A fresh-context reviewer reviews without edits and appends a new
   `## Codex Review Note`.
4. Blocking findings or reasonable non-blocking suggestions move the local
   tracker state to `Rework` and return to the original worker.
5. The original worker fixes only that issue and appends the next worker round.
6. A brand-new reviewer reviews the fix and appends the next review round.
7. Repeat until no blocking or reasonable non-blocking suggestions remain.

## Evidence Documents

All worker and reviewer rounds for an issue are append-only in its dedicated
document:

- `docs/implementation/long-term-optimization-001-evidence.md`
- `docs/implementation/long-term-optimization-002-evidence.md`
- `docs/implementation/long-term-optimization-003-evidence.md`
- `docs/implementation/long-term-optimization-004-evidence.md`
- `docs/implementation/long-term-optimization-005-evidence.md`
- `docs/implementation/long-term-optimization-006-evidence.md`
- `docs/implementation/long-term-optimization-007-evidence.md`
- `docs/implementation/long-term-optimization-global-remediation-evidence.md`

The worker round and review round in the Issue Register must match the latest
append-only notes in the corresponding evidence document.

## Evidence Note Templates

Append this exact heading and all fields for every worker round:

```markdown
## Codex Worker Note

Round: <n>
Issue: <issue id and title>
Local tracker state transition: <from> -> <to>
Branch: <branch>
PR URL: <not configured or URL>
Base revision/diff scope: <base and scoped diff>
Summary of behavior delivered: <summary>
Final scope summary: <scope completed>
Changed files/modules: <paths>
Tests added/updated: <tests>
Acceptance criteria status: <criterion-by-criterion status>
Commands run and results: <commands and outcomes>
Validation log paths: <paths or none>
Required check status or local-check handoff reason: <status or reason>
Evidence links/paths: <paths>
Decisions made: <local decisions or none>
Standards notes: <notes>
Reviewer notes: <handoff notes>
Open questions: <questions or none>
Known residual risks: <risks or none>
Blocker or context escalation details: <details or none>
```

Append this exact heading and all fields for every review round:

```markdown
## Codex Review Note

Round: <n>
Issue: <issue id and title>
Reviewer context: fresh
Reviewer edits: none
Reviewed branch: <branch>
Base revision/diff scope: <base and scoped diff>
Standards Review blocking: <findings or none>
Standards Review non-blocking: <findings or none>
Standards Review missing evidence: <missing evidence or none>
Spec Review blocking: <findings or none>
Spec Review non-blocking: <findings or none>
Spec Review missing evidence: <missing evidence or none>
Local tracker state decision: <state>
State decision reason: <reason>
```

The templates replace Linear state with local tracker state. They retain the
required worker return, readiness, and review fields from
[`docs/agents/worker-model.md`](../agents/worker-model.md) and
[`docs/agents/review-policy.md`](../agents/review-policy.md).

## Integration Checklist

- [x] Wave 1: 001 and 002 implemented in parallel and each strict review loop
      passes.
- [x] Wave 1: 001 and 002 integrated, then full current gates pass.
- [x] Wave 2: 003 implemented, reviewed through the strict loop, and integrated.
- [x] Wave 3: 004 and 005 implemented in parallel and each strict review loop
      passes.
- [x] Wave 3: 004 and 005 integrated, then full current gates plus new targeted
      checks pass.
- [x] Wave 4: 006 implemented, reviewed through the strict loop, and integrated.
- [x] Wave 5: 007 implemented, reviewed through the strict loop, and integrated.
- [x] Global remediation: 008, 009, and 010 implemented and received a fresh
      STRICT PASS at `984d0448ef5843e069ee73bcaf20ea04417d1b20`.
- [x] Global remediation: integrated into canonical and manager-owned
      integration gate passed at `2df7fef3b09f41c39fb6813f27485482ed708a46`.
- [x] ISSUE-011: deterministic journal fixture cleanup received a fresh STRICT
      PASS at `f017ba432b49a71ce06115bd9e5333608433a345`.
- [ ] ISSUE-011: merge the reviewed test-hygiene tail into canonical and record
      program closeout without changing the 008-010 product behavior.

## Wave Review Register

| Wave               | Local Review State    | Standards   | Spec        | Verified Code Revision                     | Review Evidence                                                             |
| ------------------ | --------------------- | ----------- | ----------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| Wave 1             | Complete              | STRICT PASS | STRICT PASS | `47304b2168cb8048fe7e57fad596d509a726afe2` | `docs/implementation/long-term-optimization-review.md`                      |
| Wave 2             | Integrated            | STRICT PASS | STRICT PASS | `674dcd29fdc01cf261d90501fd45ef63023ed8ac` | `docs/implementation/long-term-optimization-review.md`                      |
| Wave 3             | Complete              | STRICT PASS | STRICT PASS | `6b1ea5c1e87c713f16a2cd54d6e236d0a135d5f7` | `docs/implementation/long-term-optimization-review.md`                      |
| Wave 4             | Complete              | STRICT PASS | STRICT PASS | `0fd30da99ac2ad0f506e456ec66cecd2eb736313` | `docs/implementation/long-term-optimization-review.md`                      |
| Wave 5             | Integrated            | STRICT PASS | STRICT PASS | `54dd2c5799c203b4de4c092cac4dcb3126143d46` | `docs/implementation/long-term-optimization-007-evidence.md`                |
| Global remediation | Integrated            | STRICT PASS | STRICT PASS | `2df7fef3b09f41c39fb6813f27485482ed708a46` | `docs/implementation/long-term-optimization-global-remediation-evidence.md` |
| ISSUE-011 hygiene  | Ready for Integration | STRICT PASS | STRICT PASS | `f017ba432b49a71ce06115bd9e5333608433a345` | `docs/implementation/long-term-optimization-global-remediation-evidence.md` |

## Final Completion Gate

- [ ] All seven issues satisfy their acceptance criteria.
- [ ] All issue evidence documents contain complete append-only worker and
      review rounds, with no blocking or reasonable non-blocking suggestions
      remaining.
- [ ] Two clean reviewers run in parallel: Standards and Spec.
- [ ] Final findings return to the owning workers or integration worker, and
      each fix is reviewed by a brand-new clean reviewer until no blocking or
      reasonable non-blocking suggestions remain.
- [x] Full `npm run check` passes at
      `2df7fef3b09f41c39fb6813f27485482ed708a46`.
- [ ] All issues are `Complete` in the State Board and Issue Register.

## Global Remediation Canonical Integration

The integration worker merged
`codex/long-term-optimization-global-remediation` into
`codex/long-term-optimization` with `--no-ff` at
`2df7fef3b09f41c39fb6813f27485482ed708a46`. The final full `npm run check`
passed, so issues 008, 009, and 010 transitioned from `Complete / Ready for
Integration` to `Integrated`. The global remediation wave and program are
complete. Full gate and hygiene evidence is append-only in
[`docs/implementation/long-term-optimization-global-remediation-evidence.md`](long-term-optimization-global-remediation-evidence.md).
