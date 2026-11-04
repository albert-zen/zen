# Playwright single-page transport experiment

**Experimental, opt-in, not a replacement for the current browser provider. Do not merge as a production migration.** No production module imports this directory. The experiment has its own pinned optional dependency; ordinary ZenX installation does not install or start Playwright for Workspace pages.

## Question and conclusion so far

Can an existing Electron `WebContentsView` use the official Playwright API without exposing the app's global debugging endpoint? The protocol integration is feasible: wrap the already-authorized page debugger in a single-target CDP endpoint and call public `chromium.connectOverCDP`. Playwright then owns locators, actionability, waiting, input, frames and open-shadow DOM. Zen continues to own pages, permissions, session identity, human control and lifecycle.

This is a transport experiment, not proof of functional parity. The current Workspace/Connected implementation remains the default. Uniform model tools and human-visible behavior do not require every provider to have the same internal implementation.

## What this branch contains

- `target-transport.ts`: browser handshake plus exact page/child-session routing. It exposes one synthetic browser context and page, rejects browser-wide commands and unknown target/session identities, and has no action retry logic.
- `electron-target.cjs`: optional authenticated loopback WebSocket adapter over an existing **exclusive synthetic-page** `webContents.debugger` lease; rejects ordinary HTTP, unexpected Origin, incorrect authorization/path and a second client. The prototype refuses a debugger with existing message observers or another active experiment lease. Uses `noDefaults: true` to avoid changing existing-context defaults. Disconnect preserves the page and native debugger attachment.
- `electron-smoke.cjs`: synthetic Electron fixture covering one-target selection, textbox fill + Enter, click, open shadow root, iframe, delayed element auto-wait, screenshot and page/debugger survival after disconnect. The app shell is a separate unrelated target and must stay invisible to Playwright.
- `../../test/playwright-target-transport.test.ts`: focused protocol-boundary tests. These tests do not prove actual Chromium/Electron compatibility.

The adapter returns a Page only to the experiment runner. It does not add raw Playwright access to model tools or bypass Zen permissions.

## Run explicitly

From the repository root, after the normal development dependencies including Electron are installed:

```sh
npm ci --prefix apps/zenx/experiments/playwright --ignore-scripts
node --import tsx --test apps/zenx/test/playwright-target-transport.test.ts
# Linux needs a working display, for example an isolated Xvfb session:
xvfb-run -a node_modules/.bin/electron --no-sandbox \
  --user-data-dir="$(mktemp -d)" \
  apps/zenx/experiments/playwright/electron-smoke.cjs
```

Use only a disposable profile and synthetic fixture. Do not attach this experiment to installed-user tabs or private data. `--no-sandbox` is for the disposable CI/container fixture only, not a production launch recommendation.

## Evidence and limitations

- Protocol tests: 7/7 passing locally. Focused TypeScript check and CJS syntax checks: passing locally.
- Real-browser spike: **not run successfully**. Chromium failed before a page was created with `process_singleton_posix.cc: socket() failed: Operation not permitted`, including the approved escalated attempt. This environment does not provide a working native Electron binary in the shared dependency install either.
- Full ZenX typecheck: process killed by the local environment; not a passing result. The experiment's directly affected TypeScript files were checked separately.
- Native Electron smoke, cross-origin/OOPIF frames, popup ownership, dialog handling, uploads/downloads, cancellation during dispatch, crash/reload, reconnect, human takeover and extension connection parity remain unverified.
- Sharing the production Host debugger is **not implemented**. The prototype requires an exclusive synthetic-page debugger lease because changing auto-attach on a shared root could disturb other consumers. A production integration needs ownership and revocation coordination, not merely passing a boolean.
- The existing Connected bridge is not modified. Its browser-level handshake currently differs from Playwright and needs a separate scoped adapter using the same underlying debugger owner. A second competing browser extension is not a valid integration.
- This code does not support browser-wide contexts/storage/download configuration or creating/closing arbitrary targets. Those operations must remain explicitly owned by Zen, or be admitted separately rather than silently expanded.
- Closed shadow roots are not supported by Playwright locators either. This experiment must not promise that capability.

## Tradeoffs to establish before any adoption

Benefits: upstream locators, actionability, waiting, frame traversal and real input semantics replace custom DOM input emulation. Same Page/Locator calls can operate through different transport adapters.

Costs: an authenticated endpoint and browser/target protocol envelope remain necessary; child-session and cleanup semantics must be verified, not guessed. A native view is not automatically a public Playwright Page. CDP attachment has lower fidelity than Playwright's own protocol. Playwright auto-waiting can continue until its timeout, so permission revocation and human takeover require a proven dispatch fence; racing a Promise against an abort signal is not cancellation of an input operation.

Keep the current path unless this experiment demonstrates a clear behavioral and maintenance advantage. Do not switch defaults based only on handshake tests or line count.

## Primary sources

- [Public connectOverCDP contract and limitations](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)
- [Playwright Chromium browser handshake, pinned v1.62.1](https://github.com/microsoft/playwright/blob/v1.62.1/packages/playwright-core/src/server/chromium/crBrowser.ts)
- [Playwright Chromium page/session initialization, pinned v1.62.1](https://github.com/microsoft/playwright/blob/v1.62.1/packages/playwright-core/src/server/chromium/crPage.ts)
- [Electron debugger transport and child session IDs](https://www.electronjs.org/docs/latest/api/debugger)
- [Chrome extension debugger ownership](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [Playwright existing-browser attachment via extension](https://playwright.dev/agent-cli/commands/attach)

Related behavior and architecture context: [#590](https://github.com/albert-zen/zen/issues/590), [#672 and the newer timeout report](https://github.com/albert-zen/zen/issues/672#issuecomment-6628190612). #689 concerns rendering/composition and is separate from the automation transport.
