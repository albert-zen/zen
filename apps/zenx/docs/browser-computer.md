# Browser and Computer capability evaluation

ZenX exposes small, structured Browser and Computer tools through its existing plugin runtime. Provider resources and observations are transient; tool calls and results continue through the normal thread history. The [small-task suite](../evals/browser-computer/README.md) gives models a reusable local acceptance path without accounts or user documents.

## Design choices and comparison

The comparison below is scoped to Windows exploration on 2026-09-19. Codex was tested through its installed Computer Use plugin 26.915.31945 and in-app Browser APIs; the whole App build was not established. DeepSeek Harness was inspected at `ddefc45` (0.1.6-alpha.2) and exercised through its published alpha.2 providers. These are capability probes, not a blind model benchmark or cross-platform certification.

| Concern                      | Codex observation                                                            | DeepSeek Harness observation                                                        | ZenX direction                                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Discover a desktop target    | Lists apps, including installed apps without windows, and selectable windows | Native provider offers app/window discovery                                         | Expose running window inventory with owning application and exact reusable target; do not claim an installed-app catalog    |
| Browser semantics            | Labeled fields and disabled controls visible in AX; Unicode form completed   | Playwright MCP snapshot, form filling and click completed a local form              | Preserve structured bounded observations; resolve HTML labels and aria-labelledby consistently during inspection and action |
| Long pages                   | Coordinate scroll completed task; scrolling an AX root failed in this run    | Playwright find/click can bring the matched control into view                       | Provide explicit bounded page scrolling for providers whose inspected targets are viewport-limited                          |
| Observation freshness        | Replaced control received a new index after re-observation                   | Native workflow prescribes fresh snapshots and element tokens                       | Preserve observationId checks, invalidate after mutation, and require a new observation before another action               |
| Screenshot and accessibility | Notepad capture worked, but requested accessibility text was null            | Native provider offers screenshots and semantic actions; support varies by platform | Keep semantic actions and screenshots distinct; report unsupported operations instead of silently switching to global input |
| Provider composition         | Integrated discovery and runtime documentation                               | Experimental provider plugins expose backend-specific tools                         | Retain ZenX's shared capability contract and advertise only what the selected provider implements                           |

A richer reference tool list is not itself a reason to add dozens of tools. The first improvements address tasks that previously required a caller to already know a process/window title or to leave the browser interface to reach a lower-page control. Existing stale-target, cancellation, thread/session isolation and explicit failure behavior remain essential.

ZenX's Playwright provider already exposes DOM-visible targets outside the viewport and can auto-scroll when clicking them. Explicit scrolling still enables reading long pages without clicking. Electron and attached CDP observations expose viewport-visible targets, so scrolling also unlocks discovery of lower-page controls. These provider differences are retained rather than removing a useful existing behavior.

DeepSeek's native provider completed Unicode input and background UIA invocation in a disposable Windows editor and rejected a stale element token after re-observation. Its `verify_state` returned `satisfied` for the editable value but `unknown` for a static success label that appeared in the text snapshot. This supports keeping unverified outcomes distinct from failures and successes. Its 56-tool native catalog serialized to 106,551 characters in this installation; ZenX's progressive plugin discovery remains useful for controlling context cost.

## Acceptance and limits

- `computer_list_windows` supplies a bounded inventory with a query for narrowing results. Each returned target can feed the existing inspect/capture/action workflow. Long and empty window titles must remain usable as exact identities; display truncation must not corrupt selectors.
- `browser_scroll` binds a page viewport operation to the explicit session, tab and latest observation. Scroll then inspect again before using a control. Label-based identification uses the same name calculation in inspection and action revalidation.
- Plugin manifests, packaged first-party variants and the runtime-disclosed tool set must agree. A direct backend test alone does not establish model availability.
- Passing deterministic provider checks establishes plumbing and regression behavior. Passing a model task additionally requires the model's observed action trace and verified final outcome. Unsupported providers and setup failures remain visible in results.

The current suite does not establish reliability for nested scrolling containers, contenteditable editors, shadow DOM, cross-origin frames, file dialogs, drag-and-drop, multi-monitor/DPI layouts, or arbitrary third-party apps. Peekaboo window discovery needs a provider-specific implementation and macOS validation; it must not advertise another backend's unimplemented discovery operation. The Windows inventory covers open windows, not every installed application.

Next evaluations should prioritize nested-container scrolling and richer editable controls, then multi-window and missing-window recovery across native platforms. Attached user-browser tests must continue checking that cleanup does not close user-owned tabs. Popup creation and asynchronous tab discovery need their own acceptance case; a successful click does not prove a new tab is already visible.

## Sources

- [OpenAI Browser documentation](https://developers.openai.com/es-419/docs/browser?surface=app) and [Computer Use documentation](https://developers.openai.com/es-419/docs/computer-use) describe the product surfaces; local observations above are narrower than those general descriptions.
- [DeepSeek Harness source at the inspected revision](https://github.com/deepseek-ai/deepseek-harness/tree/ddefc45) is the source for the provider composition comparison. Provider-specific behavior is not claimed to be a universal harness contract.

Private task reports retain runtime diagnostics and experiment details. Public documentation deliberately excludes user application inventories and screenshots of existing documents.
