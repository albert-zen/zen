# Cockpit experiment (#193)

Cockpit answers one question: which parallel work deserves my attention, and what evidence can I act on? It is an optional renderer surface, not a coordinator. Enable a development/build session with `RENDERER_VITE_COCKPIT=1`; ordinary builds have no entry. No profile, model, effort or permission is changed.

## Ownership and interaction

L0 groups current ThreadSummary projections by attention, active and idle, retaining workspace labels and explicit unknowns. Idle does not imply success. Pending approvals lead to the existing conversation approval controls. L1 reads `zen/thread/read` without subscribing or resuming; canonical events and their raw source remain inspectable. Opening or selecting never sends input. Explicit Run Agent starts a normal Turn; Guide active Turn uses its observed fence; Interrupt uses its observed Turn ID. Configuration overrides are omitted. Errors and stale read times remain visible; no automatic action retry.

Only the selected task is read. A periodic read while this page is visible updates its snapshot; an unavailable Host disables actions, and failed refreshes retain old evidence marked stale. Requests from a previously selected task cannot replace the current task. External workspace Inbox stays outside this product.

## Generated component boundary

`examples/cockpit-component` is an optional normal process plugin, installed through existing Marketplace advanced source controls. It accepts agent-authored HTML (maximum 24 KiB UTF-8), title and 1–12 Item IDs. The existing tool result owns persistence and invocation lineage. No new canonical type, resource store, DSL or registry is introduced. Cockpit checks the exact content type, successful result, producing tool call and preceding same-thread source Items. References prove lineage, not truth of the author's conclusions. Invalid/missing references produce a visible error and raw result fallback.

The human explicitly opens each component. The existing Generic UI Host sandbox/CSP provides the same isolation as an external plugin UI: no same-origin, network, parent DOM or direct Electron access. Its dedicated bridge denies all commands and navigation and exposes only the declared source Items. The host shows provenance outside the frame. This is a bounded HTML experiment; arbitrary scripts can still consume renderer resources, so it is not an OS process security or availability guarantee. Components are not automatically mounted from chat, Markdown, reasoning or ordinary tool text.

## Design

Two alternatives were considered: a wall of dashboard cards obscures task identity; a full-screen conversation sacrifices overview. The selected asymmetric task rail + evidence pane keeps both anchors visible, stacking naturally on narrow screens. The signature is a quiet vertical canonical event trail: only actual events get markers, never invented completion percentages.

Palette: deep slate `#172934`, instrument blue `#284653`, mist `#edf3f4`, muted ink `#a9bec8`, amber `#f2c078`, focus ice `#91d5e3`. Display uses locally available Bahnschrift/DIN with system sans body; monospace is reserved for provenance. No web font dependency. The UI/UX search's marketing hero/CTA pattern was rejected as off-topic; its dense operations style, contrast and keyboard guidance informed the layout. Motion is limited to control feedback and respects reduced motion.

## Deliberate limits

No L3 system sensing, ambient/mobile, automatic archival, approval decisions inside generated HTML, general component language, cross-thread arbitrary source reads or independent durable UI state. Summary freshness is distinct from last activity time. The source view is canonical JSON; the conversation button opens the existing complete transcript. Future persistent component ownership requires a separate architecture decision.

## Reproduce

From the repository root after `npm ci`:

```sh
npm run build --workspace @zenx/plugin-sdk
node --import tsx --test apps/zenx/test/cockpit.test.ts apps/zenx/test/cockpit-host.test.ts apps/zenx/test/cockpit-ui.test.ts apps/zenx/test/cockpit-publish.test.mjs
node --import tsx apps/zenx/scripts/cockpit-fixture.ts
```

Open `http://127.0.0.1:5193/apps/zenx/test/fixtures/cockpit.html`. This runs a real in-memory AppServer/AgentRuntime, real WebSocket client and actual process plugin. The author is a deterministic ModelAdapter, not online provider sampling. Selecting a task reads canonical data; Run Agent, guidance and interrupt reach this disposable Host. The component reads its actual source through the isolated bridge; its boundary-check button demonstrates command rejection. Fixture scenarios inject visibly labelled overview/connection failures and unknown/approval projections. The fixture's conversation link reports the navigation target; production opens the existing thread UI.

For the desktop entry in PowerShell, set `$env:RENDERER_VITE_COCKPIT='1'` only in the development shell, then `npm run dev --workspace @zen/zenx`. See the optional plugin README for a self-contained install artifact and a real-model manual authoring prompt. No credentials or existing profile are needed by the integration fixture.
