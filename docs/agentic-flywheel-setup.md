# Agentic Flywheel Setup And Operations

This playbook describes how Zen uses Linear, Symphony, and Codex to run an automated build loop while preserving human product and architecture control.

The canonical state machine and role boundaries live under `docs/agents/`. The quality discipline that makes the loop safe lives in `docs/agents/quality-gates.md`, `docs/agents/review-policy.md`, and `docs/agents/engineering-standards.md`.

## Roles

- Linear project: private operating queue and state machine.
- Worker Symphony: polls `Ready for Agent` and `Rework`, creates isolated workspaces, and starts implementer Codex sessions.
- Reviewer Symphony: polls `Agent Review` and starts reviewer Codex sessions.
- Worker Codex agents: implement scoped Linear issues, validate them, record evidence, and hand off for review.
- Reviewer Codex agents: review only. They report standards/spec findings and move issues to the next review state.
- Human/Codex manager: orders work, handles ambiguity, releases ready DAG nodes, reviews final quality, and keeps production saturated.

## Current Project

- Linear team: `Albert's house`
- Linear project: `Zen agent`
- Project URL: https://linear.app/alberts-house/project/zen-agent-04d56f75dcff
- Local repo: `D:/desktop/zen`
- Symphony runtime repo: `D:/desktop/symphony/elixir`
- Worker workflow: `WORKFLOW.zen.worker.windows.md`
- Reviewer workflow: `WORKFLOW.zen.reviewer.windows.md`
- Linear mirror: https://linear.app/alberts-house/document/agentic-flywheel-workflows-edf09c019de8

## Current Mode: Windows Local Branch

This repo does not yet have a GitHub remote. Until one exists:

- Workers clone from `D:/desktop/zen`.
- Workers create local branches named `codex/<linear-id>-<short-topic>`.
- Workers push those branches to the local repo origin.
- Workers record branch, commit, validation, and acceptance status in Linear.
- Reviewers fetch the local branch and inspect branch diffs plus Linear evidence.
- `Agent Review` does not require a GitHub PR yet, but it does require a branch and validation evidence.

After a GitHub remote is configured, update the workflows to require PR creation and required checks before `Agent Review`.

## The Loop

1. The manager keeps the Linear backlog healthy and dependency-aware.
2. Backlog work stays parked in `Backlog`; Symphony does not poll it.
3. The manager moves ready DAG nodes to `Ready for Agent` when blockers are clear.
4. Worker Symphony claims eligible `Ready for Agent` or `Rework` issues and starts a Codex session in a fresh workspace.
5. The worker moves the issue to `In Progress`, creates a new `## Codex Worker Note`, and implements only the linked issue.
6. The worker records validation and branch/commit evidence.
7. The issue moves to `Agent Review` only after review-readiness is satisfied.
8. Reviewer Symphony runs an independent standards/spec review.
9. Passing review moves the issue to `Human Review`; bounded blocking findings move it to `Rework`; missing context moves it to `Needs Human Context`; external blockers move it to `Blocked`.
10. The manager accepts, requests follow-up work, or releases the next DAG node.

## Starting The Flywheel

From `D:/desktop/symphony/elixir`:

```powershell
$env:LINEAR_API_KEY = [Environment]::GetEnvironmentVariable("LINEAR_API_KEY", "User")
mise exec -- mix symphony.preflight.windows D:/desktop/zen/WORKFLOW.zen.worker.windows.md
mise exec -- mix symphony.preflight.windows D:/desktop/zen/WORKFLOW.zen.reviewer.windows.md
.\scripts\start-agent-flywheel.ps1 `
  -WorkerWorkflowPath D:/desktop/zen/WORKFLOW.zen.worker.windows.md `
  -ReviewerWorkflowPath D:/desktop/zen/WORKFLOW.zen.reviewer.windows.md `
  -WorkerPort 4011 `
  -ReviewerPort 4012
```

Dashboards:

```text
http://127.0.0.1:4011/
http://127.0.0.1:4012/
```

Start with `agent.max_concurrent_agents: 1`. Increase concurrency only after claim behavior, review readiness, and validation reporting are reliable.

Latest setup evidence: `docs/implementation/agentic-flywheel-preflight-evidence.md`

## Manager Duties

- Release only ready, dependency-clear issues into `Ready for Agent`.
- Keep dependent issues in `Backlog` until prerequisites are accepted.
- Watch worker/reviewer notes for repeated blockers or design drift.
- Keep the item-first design intent from `docs/design-intent.md` as the final architecture bar.
- Convert automation defects into normal Linear issues instead of fixing them ad hoc inside unrelated work.

## Pausing Safely

1. Stop moving new issues into `Ready for Agent`.
2. Stop the worker Symphony process if immediate pause is needed.
3. Let active workers finish their current turn when possible.
4. For unfinished active issues, require a worker note with branch, last validation result, blocker/pause reason, and resume step.
5. Keep unresolved work in `In Progress`, `Rework`, or `Blocked` according to the actual state.
