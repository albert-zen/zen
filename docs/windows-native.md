# Windows Native Symphony For Zen

This guide documents the Windows-native path for running Symphony against the Zen repo.

## Requirements

- Windows 10/11
- PowerShell 5.1 or PowerShell 7
- Git
- Codex CLI logged in on the same Windows user account
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

## Local-Branch Mode Notes

This repo has no GitHub remote yet. Workers therefore push local branches back to the local repo and reviewers inspect those branches. When a GitHub remote is added, update both workflow files:

- change `hooks.after_create` clone URL to the canonical GitHub URL,
- require PR creation,
- set `codex.review_readiness_repository`,
- add required GitHub checks,
- update `docs/agentic-flywheel-quality.md`.

## Safety

- Use a dedicated workspace root.
- Do not point Symphony workspaces at your normal checkout.
- Keep `agent.max_concurrent_agents: 1` until the loop is proven.
- Keep secrets in environment variables, never workflow files.

