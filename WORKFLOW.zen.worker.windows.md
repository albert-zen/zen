---
prompt_context:
  linear_project_name: Zen agent
  local_repo_path: D:/desktop/zen
  mode: local-branch
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: 'zen-agent-04d56f75dcff'
  dispatch_states:
    - Ready for Agent
    - Rework
  active_states:
    - Ready for Agent
    - In Progress
    - Rework
  terminal_states:
    - Agent Review
    - Human Review
    - Needs Human Context
    - Blocked
    - Done
    - Canceled
    - Cancelled
    - Duplicate
polling:
  interval_ms: 5000
workspace:
  root: 'D:/desktop/zen-workspaces/worker'
hooks:
  timeout_ms: 300000
  after_create: |
    $ErrorActionPreference = "Stop"
    git clone "D:/desktop/zen" .
    git remote set-url origin "D:/desktop/zen"
    git fetch origin main
    git checkout main
    git config user.email "codex-symphony@example.invalid"
    git config user.name "Codex Symphony"
  before_remove: |
    $ErrorActionPreference = "Stop"
    git status --short
agent:
  max_concurrent_agents: 1
  max_turns: 20
codex:
  command: codex --config shell_environment_policy.inherit=all app-server
  approval_policy: never
  read_timeout_ms: 30000
  thread_sandbox: danger-full-access
  review_readiness_guarded_states:
    - Agent Review
  turn_sandbox_policy:
    type: dangerFullAccess
---

You are running the Zen agent worker flywheel on Windows in local-branch mode.

Issue:

- Identifier: {{ issue.identifier }}
- Title: {{ issue.title }}
- State: {{ issue.state }}
- URL: {{ issue.url }}
- Labels: {{ issue.labels }}

Description:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

Read first:

- `AGENTS.md`
- `docs/design-intent.md`
- `docs/architecture.md`
- `docs/agents/issue-tracker.md`
- `docs/agents/worker-model.md`
- `docs/agents/quality-gates.md`
- `docs/agents/engineering-standards.md`
- `docs/agentic-flywheel-quality.md`

Worker operating model:

1. Work only in the current workspace.
2. If the issue is `Ready for Agent` or `Rework`, move it to `In Progress` before implementation.
3. Create a new append-only Linear comment for this worker round whose first line is `## Codex Worker Note`. Do not edit previous worker/reviewer notes.
4. Use the embedded `## Agent Brief` and linked local PRD/DAG files as the durable implementation spec.
5. If context, acceptance criteria, dependency state, testing intent, or decision authority is insufficient, write the missing context into the worker note and move the issue to `Needs Human Context`.
6. Keep changes focused on the current Linear issue.
7. Create a branch named `codex/<linear-identifier>-<short-topic>`.
8. Use TDD: one behavior test, minimal implementation, repeat, then refactor while green.
9. Run focused validation before committing.
10. Commit with the convention in `docs/agents/engineering-standards.md`.
11. Push the local branch to `origin` so reviewer workspaces can fetch it.
12. Update the worker note with branch, commit, validation, acceptance criteria status, residual risks, and reviewer instructions.
13. Move to `Agent Review` only when review readiness in `docs/agents/quality-gates.md` is satisfied.
14. If blocked by credentials, tools, environment, dependency, or orchestration, record the exact blocker and move to `Blocked`.

Quality bar:

- Preserve item-first design intent.
- Do not introduce parallel kernel state systems.
- Prefer deep modules and public behavior tests.
- Do not broaden scope to adjacent issues.
- Do not weaken quality gates.
- If a decision affects product behavior, public interfaces, architecture direction, data shape, security, or quality policy, move to `Needs Human Context`.
