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

The canonical GitHub origin is `https://github.com/albert-zen/zen.git`. Symphony workflows use Windows isolated workspaces with GitHub PR and required-check handoff:

- Worker workspaces run under `D:/desktop/zen-workspaces/worker`.
- Workers create `codex/<linear-id>-<short-topic>` branches and push them to the canonical origin.
- Workers open a GitHub PR and record the PR, commit, required checks, validation, and acceptance evidence.
- Reviewers inspect the PR, required checks, branch diff, and Linear evidence before handoff.
