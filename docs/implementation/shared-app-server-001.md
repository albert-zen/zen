# Shared App Server 001

## Agent Brief

Implement one pragmatic managed local path in which ZenX and IMZen use the same
running Zen App Server, so a durable Thread started in ZenX can be listed,
bound, and continued through IMZen. Preserve ZenX's private fallback for direct
launches, keep the capability out of renderers and persisted IMZen state, and
avoid any daemon election, named pipe, or credential-vault infrastructure.

Linear evidence is waived for this issue because the connector is unavailable.
The canonical handoff is the GitHub branch and pull request.

## Acceptance Criteria

- ZenX external mode requires a complete trusted loopback URL/capability pair.
- External mode creates no `AgentAppProductionComposition` or private Agent App
  transport and does not close the shared server.
- ZenX's renderer sees only same-origin `/request` and `/events`.
- One managed Windows launch owns one App Server, IMZen, and ZenX using verified
  process identities and graceful per-process shutdown markers.
- Repeated managed starts do not accumulate owned processes.
- Managed descriptors and logs do not contain the App Server capability or QQ
  app secret.
- IMZen supports `/threads` and `/bind <threadId>`.
- `/bind` validates the configured Project and selected Thread through the App
  Server before persisting the conversation binding.
- Normal QQ input after binding calls `turn/start` on that exact Thread.
- A real cross-client test proves ZenX creation/Turn, IMZen observation/bind and
  continuation, and ZenX SSE observation through one composition.
- App Server remains the only Project, Thread, Turn, and Item system of record.

## Decisions

- Keep the existing `scripts/imzen-live.ps1` ownership and descriptor model and
  extend descriptor version 3 with ZenX identity and shutdown-marker fields.
- Treat the launcher as the explicit owner of the three-process managed set.
  The IMZen and external-mode ZenX executables remain clients and never close
  the shared server themselves.
- Resolve ZenX host mode before dynamically importing production-composition
  factories. External startup acquires only a static proxy and a window.
- Keep the capability in process environment inherited by trusted Node/Electron
  main processes. Do not put it in command lines, descriptors, renderer state,
  or IMZen state.
- Use existing `thread/list`, `thread/read`, and `turn/start` protocol methods;
  no journal side channel or alternate synchronization layer is introduced.

## Codex Worker Note

### Round 1

- Added failing tests for ZenX external configuration and lifecycle ownership,
  IMZen Thread listing/binding validation, managed ZenX ownership, and a real
  shared HTTP/SSE workflow.
- Added `resolveDesktopAppServerMode` and an external `DesktopLifecycle` startup
  path. The private composition module is dynamically imported only after the
  external branch is excluded.
- Added a ZenX shutdown marker watcher for managed graceful shutdown.
- Extended `imzen-live.ps1` to build and start one App Server plus IMZen and
  ZenX, track all three identities, reuse a healthy process set, and shut down
  IMZen/ZenX before the server.
- Added `/threads` and `/bind <threadId>`; binding is persisted only after
  `project/read`/selection and `thread/read` validation.
- Added cross-client evidence proving two completed Turns on one durable Thread
  and ZenX SSE observation of the IMZen continuation.

### Round 2

- Completed focused tests, all IMZen tests, formatting, lint, typechecks,
  production/acceptance builds, Playwright E2E, ZenX pack/inspect/render, an
  external-mode packaged render, and Windows process ownership/census checks.
- Recorded the unchanged module-boundary and canceled-Turn interrupt failures
  that block the full test/coverage chains without changing unrelated runtime
  architecture or weakening a gate.
- Verified final process cleanup, committed and pushed the implementation, and
  opened the GitHub pull request against `main`.

## Validation

Completed validation:

- `desktop-app-server-mode`, `desktop-lifecycle`, `desktop-static-host`, and
  `shared-app-server-cross-client`: 16 tests passing.
- Full IMZen workspace: 27 tests passing.
- PowerShell identity-bound ownership and three-role process-census harness:
  passing.
- `npm run format:check`: passing.
- `npm run lint`: passing.
- `npm run typecheck`: passing for all workspaces.
- `npm run build && npm run build:acceptance`: passing.
- `npm run e2e`: 3 Playwright tests passing.
- `npm run zenx:pack`: passing.
- `npm run zenx:inspect`: 2,331 ASAR entries inspected, 8,965,854 bytes.
- `npm run zenx:verify-render`: passing for private fallback and external shared
  mode. External packaged render used one standalone App Server and ended with
  server exit code 0 and zero residual processes.

`npm test` is blocked by the pre-existing
`packages/framework/src/product/approval-runtime.ts` import of
`../kernel/effect-permission.js`, which fails the repository's explicit
cross-group entrypoint assertion. The run otherwise reported 60 passing test
files and 467 passing tests before a Vitest worker also exited unexpectedly.
The failing import is unchanged from `origin/main`.

`npm run coverage` is blocked in the first (`kernel`) group by the same
pre-existing module-boundary failure and the existing Windows interrupt
assertion in `test/app-server-transport.test.ts`, where a canceled Turn contains
`tool.error`. The interrupt failure reproduced in isolation. Coverage groups
and thresholds after the kernel group did not run. No gate was weakened and no
unrelated framework/runtime code was changed.

## Process Evidence

The managed descriptor is version 3 and records the App Server, IMZen, and ZenX
PID, parent PID, creation time, executable, and command line, plus separate
shutdown-marker paths. The generated capability is passed only through
inherited process environment and is cleared from the launcher's local
variables after startup.

The deterministic Windows ownership harness started and observed exactly three
managed role processes, then performed identity-bound cleanup:

```text
Managed process census passed: started=3 running=3 residual=0.
```

The packaged external-mode render started one real standalone App Server,
connected ZenX through the supplied shared URL/capability, stopped the server
through its marker, and reported:

```text
External packaged render census: serverExit=0 residual=0
```

A final worktree-wide census found zero Node, Electron, or ZenX processes.
A full QQ-connected `imzen-live start` could not be run because no
`IMZEN_QQ_SECRET_FILE` or documented local QQ credential was available in the
worker environment. The launcher parser, descriptor secrecy, repeated-start
branch, three-role status, shutdown order, PID-reuse refusal, descendant
cleanup, and zero-residual census are covered by the PowerShell harness.

## Branch And PR

- Branch: `codex/shared-app-server-001-shared-instance`
- Base: `origin/main` at `27ea04e`
- Implementation commit: `8038eab`
- Pull request: <https://github.com/albert-zen/zen/pull/1>
