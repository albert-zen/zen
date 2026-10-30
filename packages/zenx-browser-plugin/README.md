# ZenX Browser

First-party Browser package. Workspace and Connected browsers have separate tool names and approvals. Browser actions target a page in the background; native dialogs and pickers still need a human.

## Five-step model flow

1. Call `browser_connections` for an external browser, then its Connected `list_tabs` with that exact connection ref. For the built-in Workspace browser, call Workspace `list_tabs` with semantic session `main`.
2. Call `inspect` with an exact tab ref. The result has an observation ref, actionable target refs, `coverage`, and possibly `nextCursor`. `query` searches role, name, and value **only within targets the backend captured**. A missing match does not prove absence elsewhere on the page. Continue with `nextCursor` to read more of the same immutable capture.
3. Act with `click`, `type`, `select`, `scroll`, or `navigate` using the exact returned ref. Actions observe by default; without `since` they return a small self-contained subset of the real backend capture and a path to broader `inspect`. `observe:false` preserves a summary-only result. They do not activate the desktop or send global OS input. A retained target can be paired with a newer observation ref from the same exact tab; native checks still decide whether it survives.
4. Pass `since: <retained observation ref>` on the next inspect or action when retaining that first-page baseline. A diff includes fresh observation and target refs, `targetChanges.replacements` mapping old action refs to fresh refs, `targetChanges.order`, and `page.base`; apply `visibleTextChange` to the retained first-page text when present. `removedFromView` means outside this bounded view, not deleted from the DOM. Discard prior continuation pages after every new observation or first-page diff; follow its new `nextCursor` for the current tails. Use `full:true` after context loss. A cursor never refreshes action authority.
5. If a shared Workspace tab enters human control, wait for the user to return it, then inspect afresh before **any** mutation, including navigate or close. If an action says `actionCompleted:true` and `observationError`, inspect again without repeating it. An unknown effect must not be replayed; inspect current state and ask the user where needed.

`coverage.scope`, `sourceComplete`, `reasons`, and item/text continuation flags describe the actual bounded capture. Electron and attached Chrome capture viewport controls in the top document; frames, shadow roots, and unobserved offscreen regions can be omitted. Playwright ARIA capture has a bounded depth and cannot claim complete native coverage. Query filtering carries these omissions forward. `full` means self-contained for this bounded scope, never the entire page.

The Host resolves `rN` refs from trusted result provenance, prepares the exact backend and connection approval scope, claims resources, and dispatches to native providers. The package's pure model vocabulary and observation helpers do not grant authority or own durable conversation state. Existing tool names keep separate read, navigate, and interaction permissions; Workspace and Connected remain separate.

Pointer input uses CSS viewport coordinates and the real returned screenshot/`inputViewport`; it does not fall back to OS input. Key presses require an already focused observed element. File pickers, browser-native dialogs, frames, dragging, and arbitrary shortcuts are unsupported here. Site-triggered popups may still occur. A reported unknown held input needs human resolution before further automation.

## Programmable extensions

The object API is a thin view over the same tools and permission dispatch, not a second browser/session registry. Obtain available method documentation lazily from `ALL_TOOLS`. `capabilities.browser("workspace").tab(tabRef).supportedExtensions()` reports this provider's implemented extensions; Connected refs retain their exact connection/generation. Playwright does not advertise CDP network/console/evaluate support.

```js
const browser = capabilities.browser("workspace");
const supported = await browser.tab(tabRef).supportedExtensions();
await browser.tab(tabRef).extensions.network_start({});
await browser.tab(tabRef).extensions.console_start({});
// Obtain a fresh observation with inspect. Evaluation is an ACTION, not a read.
const view = await browser.tab(tabRef).inspect({});
const result = await browser.observation(view.observation).extensions.evaluate({
  expression: "document.title",
});
console.log(result);
```

`evaluate` executes an expression (including a Promise) in a **separate programmable DOM isolated world**. Pass `world:"main"` to access application globals in the pinned default execution context. Main-world evaluation requires a captured unique context identity and rejects missing/replaced contexts without falling back to an unpinned world. Neither mode promises full Playwright parity. It can mutate DOM, submit forms and make requests, so it uses existing `browser.interact` approval and consumes the latest observation. It never executes in the trusted observation-registry world. Cancellation or timeout after dispatch reports unknown effects; it does not prove the page code stopped, release an unresolved native mutation fence, or replay it.

`network_start` and `console_start` explicitly begin collection on the owned tab attachment. The provider retains these resources across fresh `run_code` calls; JavaScript guest variables do not persist. Ordinary event previews omit network headers/request bodies, URL credentials/query/hash, and object-valued console argument dumps; primitive console text is not scanned or rewritten. Exact requested snapshots remain in raw Trace/files. `network_read` / `console_read` accept `eventCursor` and `limit` (1–100); returned `data.eventCursor` advances that stream. Collection retains at most 2,000 events/4 MiB; an evicted cursor fails explicitly. Oversized event payloads are represented by `rawOnly` in the bounded page and remain in `rawPath`. Each explicit read also carries its full retained snapshot into the existing raw invocation Trace before bounded model projection; no unrequested stream is journaled. Each immutable raw file contains the full retained capture; files expire at attachment close or after 32 newer capture files. This is temporary output, not durable history. No prior traffic is reconstructed.

`network_response({requestId})` reads Chromium's retained response body only for a request observed in this exact attachment's retained history; native eviction/closed-tab errors are not hidden. `body` plus `base64Encoded` preserve response bytes. `content` returns current full top-document HTML. `screenshot` reuses existing fenced inspection and PNG artifacts; it does not promise full-page or arbitrary-element capture. Explicit diagnostics may contain page/network data, including sensitive fields; full raw results follow ordinary Trace/output-file handling, while only selected pages need be printed to the model.
