# Persistent WebView presentation experiment

**Experimental only. Do not merge as a production migration.** Nothing in this
folder is imported by the production app, and WebContentsView remains its default.
This is a real Electron guest probe, not a mock or a replacement Browser provider.

Run explicitly from the repository root after `npm ci`:

```sh
node --test apps/zenx/experiments/webview/persistent-host.test.mjs
node apps/zenx/experiments/webview/launch.mjs /path/to/disposable-evidence
```

The launch opens an isolated synthetic fixture window. It uses a disposable
profile, in-memory partitions, and an ephemeral loopback fixture server, never
production data, user accounts, saved cookies or a real website. Remove the
output directory when finished; CI uploads only synthetic screenshots and the
result JSON, never its disposable profile. Native macOS and Windows jobs run the
same probe. Missing Electron/display support is a blocked native test, not a pass.

## What is implemented

`PersistentGuestHost` keeps WebView elements outside changing panel contents.
Switching the presentation or hiding a panel changes visibility, not ownership,
DOM parent, src or element identity. Only explicit close removes an element. Main
owns native WebContents references, hardens guests before attachment, rejects
unexpected initial destinations/partitions, blocks popups and permission requests,
and limits navigation to the two synthetic fixture pages.

The real native smoke checks sandbox preferences and absence of Node, ten repeated
switch/hide/show cycles, exact WebContents identity and retained history/input
state, DOM modal pixel coverage and native input interception, CDP actions and a
fresh screenshot of the hidden guest, independent close, observable guest crash,
and host renderer reload. Screenshots are clearly synthetic, not production UI
acceptance. Assertions and errors are written to `report.json`.

The probe deliberately records renderer reload destroying the live guest as a
**migration parity blocker**. Passing the probe proves that boundary was observed,
not that reload persistence is solved. It also does not certify OS focus/IME,
file dialogs, multi-window transfers, shared interactive mirroring, or production
WorkspaceBrowser authorization and scheduling. The focus assertion observes the
Electron foreground window before/after one background action; it is not a
continuous OS focus audit.

## Follow-on integration, after the other experiments

Retain WorkspaceBrowser's main tab/session/control authority and the Playwright
experiment's action engine. Change only the surface adapter. In particular,
WorkspaceBrowserPanel currently keys its inner panel by thread, tab and open
state; putting a guest directly inside it would destroy the very state this probe
retains. A production host must live above that keyed subtree and bind guest
attachment to the actual main-owned tab, sender and lease, not trust renderer IDs.
Do not delete WorkspaceBrowserRenderer until hidden composition has demonstrated
parity. Do not add a durable recovery journal or silently replace a lost page.

This experiment neither consumes nor changes the action-engine interfaces, so it
can be rebased onto the earlier work without creating a second provider/session.
The synthetic frame/action probe must subsequently run against the actual
WorkspaceBrowser + selected action engine before integration is considered.

References: [issue #689 and revised order](https://github.com/albert-zen/zen/issues/689#issuecomment-6636186076),
[Electron Web Embeds](https://www.electronjs.org/docs/latest/tutorial/web-embeds).
Electron currently discourages WebView use because its architecture/API stability
is not guaranteed. This experiment does not override that tradeoff.
