# Browser and Computer small-task evaluation

This suite compares a model using a harness, and also supports deterministic provider regression checks. It uses disposable local pages and editor windows, without accounts or external services. Run browser and desktop evaluations separately: a provider may support one but not the other.

## Run a model evaluation

1. Start `node apps/zenx/evals/browser-computer/fixture.mjs` from the repository root. It binds only to loopback and prints a URL on an available port. Each page navigation resets its state. Keep the process running until evaluation finishes.
2. Select tasks from `tasks.json`. Substitute `{baseUrl}` with the printed origin. Give the model only the task prompt and normal harness tool documentation, not fixture source or the evaluator rubric. Use a fresh conversation and browser session for each browser task. Do not touch existing user tabs.
3. The model must use the harness Browser/Computer tools. Shell, direct HTTP, arbitrary page JavaScript and filesystem operations may prepare fixtures or collect evaluator evidence, but must not solve the model's task. If a harness exposes only scripting, record that execution surface explicitly and enforce the same observe/action constraints.
4. Record model/version, harness commit/version, OS, provider, input modalities, viewport, permissions, wall time, tool calls, errors, and final observation. A screenshot or accessibility snapshot showing the outcome is required. For B4, also retain tab inventory. Desktop tasks need an evaluator-provided disposable editor; never reuse user documents.
5. Score each task `pass`, `fail`, `unsupported`, or `blocked`. Missing provider capability is unsupported; a permissions/runtime setup failure is blocked. Do not relabel either as passed. Report all four counts, not just a success percentage over successful starts. Repeat with at least three fresh trials before comparing model reliability; a single run is exploratory evidence.

The local page PASS markers are convenient outcome witnesses, not secure graders. The evaluator must inspect the action trace for shortcuts and verify every success condition. In particular, B3's page cannot prove that an observation was refreshed and B4's marker cannot prove two tabs remain open. A trusted deterministic test may deliberately reuse a stale selector to test rejection; the model prompt instead asks for correct operation. Keep those results separate.

### Run through a live ZenX app

`browser-computer-model-eval.ts` drives the model configured inside an already-running ZenX app through its native App Server protocol. It does not launch ZenX or provide a model adapter. Start the fixture and ZenX separately, then pass the app's connection descriptor and an exact label or opaque id from its `model/list` result:

```sh
npx tsx apps/zenx/scripts/browser-computer-model-eval.ts \
  --descriptor <zenx-user-data>/runtime/app-server.json \
  --model "<exact configured model label or id>" \
  --base-url http://127.0.0.1:<fixture-port> \
  --task B1 \
  --output <private-evidence-directory> \
  --trials 1 \
  --timeout-ms 600000
```

The runner accepts browser tasks whose ids match `B<number>` in `tasks.json`, including newly added tasks; it does not hardcode the current list. It creates a fresh ZenX thread and unique Browser session hint for every trial and runs trials sequentially because hosted Browser/Computer resources may have a global lock. The default single trial is exploratory. Use at least three fresh trials for reliability comparisons.

The output directory must not already exist; the runner creates it atomically, then creates an empty `workspace/` beneath it as the model's cwd so repository instructions and fixture source are not exposed through the task workspace. `run.json` records the requested and resolved model, each `*.events.jsonl` retains ordered raw thread notifications, each `*.result.json` contains the final thread snapshot and timing/timeout/interrupt state, and `summary.json` provides a compact protocol-level index. `terminalReceived` means a terminal event was observed; `completed` is true only when that event reports a completed turn. These files do not assign semantic `pass` or `fail`; review the trace, final observation and task rubric manually. A timeout causes the runner to interrupt only its own thread, wait briefly for a terminal notification, read the thread, and close the client. Protocol control requests are independently bounded to at most 30 seconds. If connection initialization never returns a client that can be closed, the CLI exits at that bound so the operating system closes the pending socket. If no terminal state arrives after interruption or a control request times out, it stops before the next trial to avoid competing for the same hosted resource.

Treat this output as private evidence. Thread snapshots and Browser/Computer notifications can contain local paths, page content, screenshots, and application or window metadata. They contain no intentionally logged credential values, but should still be redacted before any public report. The runner reads authentication from the descriptor's token file and never prints or copies the token.

## Record a result

Use one JSON object per trial in a private `.jsonl` evidence file:

```json
{
  "taskId": "B1",
  "trial": 1,
  "model": "exact model ID",
  "harness": "ZenX",
  "revision": "git SHA",
  "provider": "electron-dedicated-browser",
  "os": "win32",
  "viewport": "1280x800",
  "status": "pass",
  "seconds": 12.4,
  "toolCalls": 5,
  "errors": [],
  "evidence": ["relative/path/to/trace", "relative/path/to/final.png"],
  "notes": "Observed exact Unicode confirmation"
}
```

Record manual interventions and infrastructure setup separately from task time. Remove private app titles, account details and paths from any publicly shared report; retain originals only in private evidence storage. This repository does not contain a cross-model leaderboard or claim model success from unit tests.

## Provider checks

Run `node --test apps/zenx/test/browser-computer-eval.test.mjs` to check fixture outcomes. Product regression coverage lives in `apps/zenx/test/` and exercises actual capability APIs and provider behavior. The fixture is also reusable by real Electron, Playwright, CDP and other harness drivers; readiness is the printed URL, and completion is an observed UI outcome. Desktop tools that return only app names without selectable window identities cannot pass C1.

Current scope: page scrolling, ordinary labeled text fields, fresh observations, tab ownership, disabled controls, window discovery, Unicode input and missing-window recovery. B6 additionally probes native select, checkbox and contenteditable handling, and treats an honestly reported capability gap as unsupported rather than passed. See the [native ZenX model evaluation report](../../docs/browser-computer-model-evaluation.md) for the current real-model evidence and qualifications. Nested scroll containers, cross-origin frames, shadow DOM, file dialogs, drag-and-drop and multi-monitor/DPI behavior require additional tasks and are not implied by a pass here.
