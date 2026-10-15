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

- The parallel-input fixture injects a passive provider CDP timeline and writes `browser-provider-cdp-diagnostic.json` after existing cleanup. Timer arming/deadline, actual timeout callback, send attempt/return and original receive disposition are distinct. Same-route replies observed after timeout remain ignored if the provider has no late handler; they never restore the original unknown outcome. Node callback timestamps are not wire arrival or Chrome execution times. Bounded head/tail, failed-request summaries, drop/eviction/observer-error counts and an explicit cleanup cutoff expose incomplete evidence. No new RPC, retry, wait window, AX sample or event-loop monitor is added; even synchronous observation adds small overhead. This is diagnostic evidence for [#397](https://github.com/albert-zen/zen/issues/397), not a root-cause fix.

- The disposable parallel-input smoke polls user, agent and input-contract document readiness only after a successful boolean `false` read, using its existing 20-second poll budget and 50ms interval. `true` advances; timeout, disconnect, protocol/evaluation rejection and non-boolean replies fail before later fixture actions. Initial provider inspection separately retries only `UserBrowserDocumentChangedBeforeDispatchError`; unknown outcomes fail once. Deterministic tests execute the actual fixture statements with mocked reads and a virtual clock. This establishes the fixture's error boundary, not native browser reliability or a fix for the startup `Page.createIsolatedWorld` issue ([#397](https://github.com/albert-zen/zen/issues/397)); production provider deadlines and guards are unchanged.
- `computer_list_windows` supplies a bounded inventory with a query for narrowing results. Each returned target can feed the existing inspect/capture/action workflow. Long and empty window titles must remain usable as exact identities; display truncation must not corrupt selectors.
- `browser_scroll` binds a page viewport operation to the explicit session, tab and latest observation. Scroll then inspect again before using a control. Label-based identification uses the same name calculation in inspection and action revalidation.
- Plugin manifests, packaged first-party variants and the runtime-disclosed tool set must agree. A direct backend test alone does not establish model availability.
- Passing deterministic provider checks establishes plumbing and regression behavior. Passing a model task additionally requires the model's observed action trace and verified final outcome. Unsupported providers and setup failures remain visible in results.

The current suite does not establish reliability for nested scrolling containers, contenteditable editors, shadow DOM, cross-origin frames, file dialogs, drag-and-drop, multi-monitor/DPI layouts, or arbitrary third-party apps. Peekaboo window discovery needs a provider-specific implementation and macOS validation; it must not advertise another backend's unimplemented discovery operation. The Windows inventory covers open windows, not every installed application.

Next evaluations should prioritize nested-container scrolling and richer editable controls, then multi-window and missing-window recovery across native platforms. Attached user-browser tests must continue checking that cleanup does not close user-owned tabs. Popup creation and asynchronous tab discovery need their own acceptance case; a successful click does not prove a new tab is already visible.

The default ZenX workspace browser now uses one Thread-bound WebContentsView target for both the visible human tab and Browser tools. Agent session close detaches tool ownership without closing the user's page. The `user-browser-cdp` provider also accepts the bundled public Chrome extension and Native Messaging bridge: the user clicks the extension inside ordinary Chrome to connect exactly one existing tab, preserving that tab's current login state without exporting cookies or enumerating the profile. Clicking again, disabling the extension, or quitting ZenX revokes the connection. The tab remains in Chrome; the Attached browser panel is an observation surface and must not be presented as an embedded copy or assumed live mirror. The older explicit loopback CDP endpoint remains available for isolated development profiles.

Computer panels may subscribe to the latest exact window targets used by Computer tools. On macOS the built-in provider captures at most one frame at a time every 750 ms while subscribed, reports each capture timestamp, and stops immediately when the panel unsubscribes. This is a live observation surface, not authority to control the window; Computer actions retain their existing semantic/foreground permission boundaries.

## Incremental observation contract

Current Browser/Computer inspection uses a self-contained bounded first page,
immutable cursor continuation and optional explicit-baseline diff. The package
[Browser guide](../../../packages/zenx-browser-plugin/README.md) and
[Computer guide](../../../packages/zenx-computer-plugin/README.md) define fields,
capture/output limits, reference freshness and recovery. A truncated view is
never described as a complete page/tree. Native omissions, unknown completeness
and captured-but-unread tails are separate states.

Diffs apply only to the retained first-page view. Discard old tail pages when a
new observation arrives. Context compaction does not implicitly preserve a
baseline: omit `baseObservationId` or request `full: true` when its contents are
no longer available. Host-local caches are bounded and disposable; ordinary
tool results remain the only recorded trace, with no second durable ledger.

Browser identity follows actual surviving DOM objects and document incarnation;
Computer continuity uses only a unique exact full-fingerprint presentation key.
Neither bypasses a fresh action observation or native target revalidation.
Paging broadens access to already captured data; targeted find/subtree queries,
unbounded native traversal, nested-container scrolling and image diffs remain
outside this change.

The design draws on agent-browser's scope-keyed delta/full snapshots and
Playwright MCP's snapshot-local action references. These are engineering
precedents, not evidence that every Codex browser operation uses diff output:

- [agent-browser snapshots](https://agent-browser.dev/snapshots) and
  [v0.38.0 release](https://agent-browser.dev/changelog#v0380)
- [Playwright MCP snapshot documentation](https://github.com/microsoft/playwright.dev/blob/main/mcp/snapshots.mdx)

## Sources

- [OpenAI Browser documentation](https://developers.openai.com/es-419/docs/browser?surface=app) and [Computer Use documentation](https://developers.openai.com/es-419/docs/computer-use) describe the product surfaces; local observations above are narrower than those general descriptions.
- [DeepSeek Harness source at the inspected revision](https://github.com/deepseek-ai/deepseek-harness/tree/ddefc45) is the source for the provider composition comparison. Provider-specific behavior is not claimed to be a universal harness contract.

Private task reports retain runtime diagnostics and experiment details. Public documentation deliberately excludes user application inventories and screenshots of existing documents.

The Browser registry now keeps Workspace and one external browser available together. Chrome and Edge have separate, explicitly requested native-host registration locations. A competing external connection is rejected without replacing the current one. The [concurrency contract](../../../docs/browser-concurrency.md) records tool namespaces, reference and permission isolation, and native platform validation limits.

## Verified Windows semantic client

Windows app builds now package the explicitly named `zenx-winapp-uia` downstream
separately from official/system WinApp. Its source, patch, SDK and reviewed NuGet
closure are fixed at build time. The existing compiled provider-manifest digest
covers the native executable, complete native binary directory and supporting
provenance. Every native launch rechecks that closure and the private contract.

Only that verified client can use the strict semantic route with automatic focus
disabled. A fresh opaque observation carries exact native process/window/control
identity; mutations revalidate it and call one specified UIA pattern once.
Virtual controls, ambiguity, stale identity and unsupported patterns are refused.
The client does not request activation or global input. The target application
can still activate itself, and final validation cannot make an external provider
atomic. Interrupted calls that may have dispatched report an unknown outcome;
they are not automatically repeated. Stock/system WinApp keeps explicit foreground
permission and its activity indicator. Strict background capture is unchanged.

The packaged Windows fixture checks actual Unicode readback and an independent
button effect while a separate guard process measures foreground events and
samples. This is bounded fixture evidence, not certification of arbitrary apps.
See [the native acceptance scope](windows-packaged-uia-smoke.md).
