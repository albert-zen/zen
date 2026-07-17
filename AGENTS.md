# Agent Workflow

This repo uses a Canvas-driven, Linear-backed agentic workflow.

## Canonical Docs

- Architecture intent: `docs/design-intent.md`
- Architecture map: `docs/architecture.md`
- PRDs: `docs/prd/`
- Issue DAGs and evidence: `docs/implementation/`
- Issue tracker and state machine: `docs/agents/issue-tracker.md`
- Worker/reviewer model: `docs/agents/worker-model.md`
- Quality gates: `docs/agents/quality-gates.md`
- Review policy: `docs/agents/review-policy.md`
- Engineering standards: `docs/agents/engineering-standards.md`
- Flywheel operations: `docs/agentic-flywheel-setup.md`

## Operating Rules

- Preserve Zen's item-first design intent. `ItemList` is the source of truth.
- Keep implementation tasks scoped to one Linear issue.
- Use TDD for implementation issues.
- Prefer deep modules: small interfaces, meaningful behavior behind them, and clear locality.
- Do not weaken quality gates to finish an agent issue.
- Record worker progress in append-only `## Codex Worker Note` comments.
- Record reviewer findings in append-only `## Codex Review Note` comments.
- Move issues through the Linear state machine in `docs/agents/issue-tracker.md`.

## Current Automation Mode

This repo currently has no GitHub remote. Symphony workflows are configured for Windows local-branch mode:

- Worker workspaces clone from `D:/desktop/zen`.
- Workers push local branches back to the local repo.
- Reviewers inspect local branch diffs and Linear evidence.
- GitHub PR/check handoff becomes required after a canonical remote is configured.
