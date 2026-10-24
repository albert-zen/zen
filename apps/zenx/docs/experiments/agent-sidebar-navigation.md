# Agent sidebar navigation: review-only prototype

Status: default off and **not connected to production**, on purpose. This is an executable Host/view contract prototype, not a delivered desktop feature or a visual end-to-end demo. No new tool is installed or advertised to models, no IPC channel is added, and app startup never instantiates it. Tests opt in using `enabled: true` and injected fixture ports. No user desktop, local Codex, browser session, account, or private user file was accessed to build this prototype.

## Placement and scope

Recommend a narrowly scoped `zenx_ui_navigate` tool in the existing self-control package, separate from its Thread mutations. The model chooses only one navigation intent:

- `show`: reveal the current Thread's right-side content pane.
- `set_fullscreen` plus boolean `fullscreen`: expand/restore that pane within ZenX, **not OS/Electron full-screen**.
- `open_file` plus exact `path`: preview through existing workspace-file handlers, preserve dirty drafts, do not write a file or return its contents to the model.
- `open_website` plus HTTP(S) `url`: create/select the current Thread's workspace-browser target through existing Browser Host checks. Not page interaction, external-app launch, script evaluation, or new browsing permission.
- `list_pages`: inspect a bounded current inventory of navigation IDs/titles.
- `open_page` plus exact `pageId`: navigate to an already registered page, never execute a plugin command/tool.

This follows the existing shared UI ownership rather than adding Computer automation, a Core entity, a second router, or a durable navigation journal. Any future actual model invocation/result belongs in the existing canonical tool-call/result lifecycle. Client/view bindings disappear with the process and are not reconstructed from historical calls.

The user confirmed that “StartAgent” means Subagents. On current main, `packages/zenx-subagents-plugin/zenx.plugin.json` registers a **panel**, not a page route: plugin `zenx-subagents`, panel `subagents`. The inventory adapter exposes the exact target `panel:zenx-subagents:subagents` and selects the existing `plugin:zenx-subagents:subagents` tab. This does not create or send to a Subagent. Unregistered labels are still rejected, and disabling/unloading the panel removes the navigation target.

## Why the existing bridge cannot simply be exposed

- `src/main/capability-service.ts`, `#pluginUiPort.executeCommand`, dispatches a registered plugin **tool**, not a safe navigation operation. Forwarding arbitrary command IDs would widen the permission surface.
- `src/main/index.ts`, `capabilities.onPanelOpen`, currently sends the panel event to **all windows**. Model UI commands must not reuse that broadcast.
- On rechecked base `7ac6bf05`, `src/tool.ts`, `ToolInvocation`, contains canonical call and Thread identity plus target-owned `approvalScope` (key/label/generation), but no trusted originating UI-client identity. Approval scope identifies a tool target, not the source UI window. Selecting the focused window, matching a window by Thread, or accepting `clientId` from arguments is not an adequate substitute.
- `src/renderer/src/auxiliary-panel.tsx` already owns pane expansion, selection, file drafts and browser tabs. Its manual handlers should remain the single behavior path, rather than copying those state machines into a new tool.

- Current `workspace-browser.ts` already has sender-bound presentation leases, request IDs, a 750 ms presentation wait and mount acknowledgment. Its automatic browser presentation may fall back to a renderer currently viewing the Thread; that is not proof of the originating client for a general model UI-control command. Reuse its sender/lease/ack patterns, not the fallback owner inference.
- Current self-control routes explicit Host targets through Fleet and preserves cross-Thread Agent-message provenance. Neither Host identity nor message client-id is a renderer/window capability; the experiment must not fall back from a remote target to a local window.

## Implemented boundary

`src/main/experimental-sidebar-control.ts` parses a strict action allowlist and requires a one-use, Host-issued binding of the exact invocation object to the exact client, connection/view generation and Thread. The model cannot specify or override those identities. A required Host authorization callback runs before dispatch. Disconnect, view switch, policy rejection, abort, and missing acknowledgment fail explicitly; commands are never automatically retried. Returning `applied` requires the view port's acknowledgment. A rejected dispatch, or a missing or stale acknowledgment, conservatively reports an uncertain outcome with the underlying reason. A pre-dispatch Host authorization denial remains a definite denial.

`src/renderer/src/experimental-sidebar-view.ts` is a typed, injectable view adapter. It applies presentation callbacks only after checking the bound context, and rechecks after async file/browser operations. Resource access remains with injected existing Host handlers. This module is not imported by the production App or AuxiliaryPanel.

A browser tab may already have been created when revocation occurs during an awaited Host operation. The adapter suppresses stale selection; it does not promise rollback, close the tab, or retry. Host effects and renderer acknowledgment are not an atomic transaction.

These are trusted in-process prototype ports, not a remotely secure transport. Calling `bindInvocation` is an admission privilege; do not expose it through plugin UI SDK, arbitrary renderer IPC, or model arguments. `generation` must change on connection replacement **and** view/selection ownership changes, even when the Thread ID stays the same.

## Required before a user-visible opt-in

1. Carry a trusted originating-client capability through actual request/Turn admission to each exact canonical invocation. Preserve it only where explicitly authorized, never infer it for IM/external/headless calls. Reject unsupported provenance rather than targeting a convenient desktop window. Review scope with existing host policy.
2. Add a default-off user-facing experiment switch and model-tool registration only when that switch and required policy capabilities are active. No guessed env-var enablement or automatic activation.
3. Adapt the existing UI bridge with **single-recipient**, connection-generation-bound request/ack routing, bounded timeout/cancellation, renderer sender verification, and no replay after an uncertain outcome. Reuse existing runtime task lifetime rather than inventing a command ledger.
4. Wire the view adapter to existing AuxiliaryPanel handlers; keep file draft conflict behavior and selection epochs. Resolve absolute paths using the existing `messageFilePath`/Thread cwd flow, then let `readWorkspaceFile` enforce canonical workspace bounds. Do not introduce a second path permission algorithm.
5. Route website opens to `workspaceBrowser.command` with the exact bound sender and Thread. Retain its URL, browser availability, target ownership and Host permission checks; do not substitute `shell.openExternal` or allow arbitrary JS.
6. Use the prototype inventory adapter over current registered plugin pages **and panels**, retain Generic UI Host routing, and handle unload between inventory and dispatch. Do not send arbitrary routes or invoke plugin tools to “open” pages.
7. Add actual Electron multi-window/connection-replacement/Thread-switch UI tests and visible focus, dirty-draft, modal, fullscreen-restore and navigation verification. The current tests are not evidence those behaviors already work end to end.

## Public Codex comparison

Only public documentation was read; the user's local Codex was never invoked. The old official Codex browser and commands URLs currently redirect to ChatGPT Learn. Those pages document a shared in-app browser and user keyboard commands, with browser permissions distinct from UI visibility. They do **not** establish a public model-to-sidebar API or reveal private Codex implementation. The transferable idea is a shared view with a narrow navigation surface; the routing and provenance design above is a ZenX proposal, not a claim about Codex internals.

- https://developers.openai.com/codex/app/browser redirects to https://learn.chatgpt.com/docs/browser?surface=app
- https://developers.openai.com/codex/app/commands redirects to https://learn.chatgpt.com/docs/reference/commands

## Validation

Revalidated against current `origin/main` base `7ac6bf05`; the earlier stale-base validation is superseded.

Run from repository root:

```sh
node --import tsx --test apps/zenx/test/experimental-sidebar-control.test.ts
```

The focused suite exercises all actions, opt-in/default-off, client/Thread/generation identity, forged routing fields and unsupported operations, exact page resolution, duplicate dispatch prevention, abort, denial and async view revocation, uncertain acknowledgment, and actual workspace path/symlink escape rejection. File content is deliberately absent from the model receipt. It uses fixture view ports; it does not launch Electron or open a real website.
