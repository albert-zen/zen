# Windows Native Symphony For Zen

This guide documents the Windows-native path for running Symphony against the Zen repo.

## Requirements

- Windows 10/11
- PowerShell 5.1 or PowerShell 7
- Git
- Codex CLI logged in for Symphony worker automation only; Zen production uses
  its Pi-backed ChatGPT subscription adapter and never launches Codex CLI
- Node.js on `PATH`
- `mise` for Erlang/Elixir in the Symphony runtime repo
- Linear API key stored in `LINEAR_API_KEY`

## Runtime Locations

- Symphony runtime: `D:/desktop/symphony/elixir`
- Zen repo: `D:/desktop/zen`
- Worker workflow: `D:/desktop/zen/WORKFLOW.zen.worker.windows.md`
- Reviewer workflow: `D:/desktop/zen/WORKFLOW.zen.reviewer.windows.md`
- Worker workspace root: `D:/desktop/zen-workspaces/worker`
- Reviewer workspace root: `D:/desktop/zen-workspaces/reviewer`

## Preflight

Run from `D:/desktop/symphony/elixir`:

```powershell
$env:LINEAR_API_KEY = [Environment]::GetEnvironmentVariable("LINEAR_API_KEY", "User")
mise exec -- mix symphony.preflight.windows D:/desktop/zen/WORKFLOW.zen.worker.windows.md
mise exec -- mix symphony.preflight.windows D:/desktop/zen/WORKFLOW.zen.reviewer.windows.md
```

## Start Worker And Reviewer

```powershell
.\scripts\start-agent-flywheel.ps1 `
  -WorkerWorkflowPath D:/desktop/zen/WORKFLOW.zen.worker.windows.md `
  -ReviewerWorkflowPath D:/desktop/zen/WORKFLOW.zen.reviewer.windows.md `
  -WorkerPort 4011 `
  -ReviewerPort 4012
```

## Stop

```powershell
.\scripts\stop-windows-native.ps1 -PidFile "$env:LOCALAPPDATA\Symphony\agent-flywheel\symphony.worker.pid.json" -Force
.\scripts\stop-windows-native.ps1 -PidFile "$env:LOCALAPPDATA\Symphony\agent-flywheel\symphony.reviewer.pid.json" -Force
```

## Windows Worktree And GitHub Delivery Notes

The canonical GitHub origin is `https://github.com/albert-zen/zen.git`. Windows workers and reviewers continue to use dedicated local worktrees under `D:/desktop/zen-workspaces`, while delivery uses the GitHub PR and required-check handoff:

- workers push `codex/<linear-id>-<short-topic>` branches to the canonical origin,
- workers open a GitHub PR and record its URL, commit, validation, acceptance, and required-check evidence in Linear,
- reviewers inspect the PR, required checks, branch diff, and Linear evidence before accepting the handoff.

## Safety

- Use a dedicated workspace root.
- Do not point Symphony workspaces at your normal checkout.
- Keep `agent.max_concurrent_agents: 1` until the loop is proven.
- Keep secrets in environment variables, never workflow files.
