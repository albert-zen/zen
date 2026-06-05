# ALB-94 Dogfood Coding-Agent Acceptance Scenario

This scenario proves Zen can run a small coding task through the real
OpenClaw-configured model, the App Server HTTP transport client, and the
shell-first `ToolRuntime`.

## Command

```powershell
npm run dogfood:alb-94
```

The script builds the TypeScript package, creates a temporary fixture repo, then
starts a real Zen thread against the configured OpenClaw provider. The model is
asked to inspect the fixture, edit `src/greeting.js`, run `npm test`, and return
a concise final answer.

## Safety

The fixture is created outside the main repo under the OS temp directory by
default. Thread persistence is scoped inside the fixture workspace, so the main
repo is not mutated except for the transcript path below.

## Evidence

Default transcript:

```text
docs/implementation/alb-94-dogfood-acceptance-transcript.md
```

The transcript records:

- pass, fail, or skip status,
- fixture workspace path,
- shell commands used for inspect, edit, and test,
- validation output,
- final assistant answer,
- App Server protocol notifications.

## Configuration

By default the scenario uses `C:\Users\<user>\.openclaw\openclaw.json`, matching
the OpenClaw runtime factory. Optional overrides:

```powershell
$env:ALB94_DOGFOOD_CONFIG="C:\path\to\openclaw.json"
$env:ALB94_DOGFOOD_EVIDENCE="docs\implementation\alb-94-dogfood-acceptance-transcript.md"
$env:ALB94_DOGFOOD_FIXTURE_ROOT="$env:TEMP\zen-dogfood"
$env:ALB94_DOGFOOD_TIMEOUT_MS="180000"
npm run dogfood:alb-94
```

Missing config, missing credentials, or unavailable provider/network access are
recorded as `Status: skipped`, not `Status: passed`. A failed run exits nonzero.
