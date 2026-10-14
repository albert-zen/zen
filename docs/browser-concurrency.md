# Concurrent Workspace and external browsers

ZenX keeps its Thread-owned Workspace browser available when the user enables an external browser connection. This change builds on the human takeover and fresh-observation return contract in [browser-human-control.md](browser-human-control.md). It does not change those controls or the native navigation-completion fence.

## Routing and permission boundaries

The process-local Browser backend registry holds a shared Workspace package and lazy per-instance external packages:

- `browser_workspace_*` addresses the shared Workspace browser.
- `browser_connections` discovers opaque connection IDs, browser labels and states only, without page titles, URLs or personal profile information.
- `browser_connected_*` requires an explicit `connectionId` from discovery, even when only one browser is connected.

The twenty-four tab/session tools share their existing schema factory; discovery makes twenty-five declared tools regardless of the number of profiles. The four targeted click/key tools retain exact observed-tab input even when another Chrome tab or app is active; native picker/dialog surfaces require human control rather than an automatic foreground fallback. Under `ask_unknown`, a trusted Host catalog resolves a stable instance approval key and a current dispatch generation before admission. Scoped decisions and pending prompts use separate Core storage, never legacy tool-name decisions. The same stable instance can reuse an approved tool after reconnect, but an already prepared call and all old references fail generation validation. Different Chrome/Edge instances, including profiles of the same browser, require independent approval. Full Access remains the user's explicit policy; a scoped composite cannot broaden its captured target while nesting calls. Scoped runtimes are local-only because generic Fleet remote execution does not yet carry instance admission. See [tool-approval-scopes.md](tool-approval-scopes.md).

Tool API migration is explicit: old `browser_*` calls fail after a successful concurrent upgrade rather than retrying on a new backend. The Agent must refresh the capability catalog and list/inspect using the new tool names; old tab and observation references are not redirected.

Start with `browser_connections`, then call the chosen instance’s `browser_connected_list_tabs`; use `browser_workspace_list_tabs` for Workspace. Results include `backendId` and, for an external instance, `connectionId`; tab, observation, target and continuation references are backend-qualified and must be passed unchanged to the corresponding namespace. Separate provider sessions, observation presentation caches, native targets, latest-observation validation and live subscription generations prevent collisions or delayed responses from redirecting work. A missing external provider fails explicitly and never falls back to Workspace. Closing an external session detaches ZenX and leaves the user's tabs and profile intact; closing a Workspace session also preserves shared pages. Workspace takeover still blocks mutations, and return still requires a fresh observation, including for navigate and close.

The ordinary settings page offers an additional external connection, rather than an exclusive provider selector. The legacy `browserMode` profile field is retained for compatibility: `user-session` now opts in to the additional backend. The external opt-in takes effect after restart. An explicit developer `ZENX_BROWSER_MODE=isolated` continues to select the legacy isolated provider path; `user-session` uses coexistence.

Provider upgrades are transactional: the committed runtime/backend and captured capability generation stay live until the new profile Catalog commits. Corrupt archives, runtime-admission failure and Catalog-save failure leave the old route intact. Restarting with an explicit isolated selector first restores the committed concurrent generation from the app-owned Workspace resource, then switches only through that transaction. After commit, the previous provider remains alive until its exact Supervisor generation has drained prepared calls, captured Host leases and dispatched operations; completed and failed operations keep their actual outcomes. The Host observes that existing retirement signal rather than introducing a second lifetime counter. Retiring a shared Workspace capability then releases only its own opaque session leases; it cannot close another generation’s sessions.

## Chrome and Edge setup

The user chooses Google Chrome or Microsoft Edge in Browser settings before explicitly registering or removing that browser's native host. Merely choosing a browser writes nothing. Registration and discovery remain separate for each browser:

- Chrome: existing Chrome native-messaging locations.
- Edge on Windows: `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.zenx.chrome_bridge`, with a separate Edge manifest file.
- Edge on macOS: `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/`.
- Edge on Linux: `~/.config/microsoft-edge/NativeMessagingHosts/`.

Only the bundled unpacked extension's exact keyed origin is allowed. There is no wildcard, store-origin guess, cookie export, profile migration or automatic registration. This supports the bundled unpacked extension workflow; an independently published Edge Add-ons extension may have a different ID and is not implicitly trusted.

The user loads the extension through `chrome://extensions` or `edge://extensions` and explicitly clicks it to connect. Existing browser-wide consent, lazy debugger attachment, narrow CDP command allowlist and disconnect semantics remain intact. Chrome, Edge and distinct extension installations can connect together. Protocol 3 keeps a random UUID in extension-local storage (not sync storage); browser/account/profile names and email addresses are never read. The short browser-plus-ID label appears in settings, target previews and approval prompts. Reload the updated extension in each browser after upgrading. Cloning extension storage also clones this installation identity; simultaneous duplicates are rejected, and reinstalling the extension creates a new identity that requires fresh approval.

The bridge owns independent native sockets, tabs, CDP client views, pending commands and session maps per connection incarnation. HTTP/CDP routes contain an exact Host-selected instance and generation; one client cannot enumerate another instance. A disconnect rejects only that connection's pending work and retires its provider. A duplicate live identity receives a clear rejection without replacing the current socket. The legacy single-provider bridge API is retained only for legacy consumers; the multi-instance path never chooses a default external browser.

Core captures approval scope before prompting. The child Host forwards that trusted snapshot outside tool arguments; the main-process registry checks its key and generation immediately before resolving the exact instance and again after asynchronous connection. Host catalog refresh publishes connection changes without inventing new Thread state. Already dispatched operations retain actual results; neither catalog refresh nor reconnect silently retries them.

## Evidence and limits

Automated tests cover native-ID collisions, cross-backend reference rejection, independent latest-observation invalidation and session closure, disabled-provider failure, separate remembered tool approvals, merged read-only target previews (including synchronous metadata, most-recent Agent activity across backends and explicit pinning), diff action references, failed/successful real-tarball profile migrations, generation-specific Workspace leases, registry startup, Workspace human takeover and fresh return, simultaneous instance routing and duplicate-identity rejection preserving in-flight commands, explicit Edge UI registration, platform-specific paths, exact origin restriction and independent removal. Packaging parity compares the generated runtime manifest to the shipped concurrent and multi-instance variants.

Native Windows/macOS/Edge acceptance is separate from Linux unit or path tests. No native Edge result is claimed without a real Edge run. Tests use disposable user data and synthetic content; they do not authorize use of real accounts or sensitive browser state.

## Official references

- [Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger): debugger permission, explicit targets/session IDs and detach behavior.
- [Microsoft Edge native messaging](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging): OS-specific registration paths, exact allowed origins, stable-channel locations and extension-ID differences.
- [Port Chrome extensions to Edge](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/port-chrome-extension): native messaging origin requirements.
- [Electron webContents](https://www.electronjs.org/docs/latest/api/web-contents): native page and navigation ownership, as preserved by the prerequisite handoff implementation.

- [Chrome extension storage](https://developer.chrome.com/docs/extensions/reference/api/storage): extension-local storage persists across worker restarts, is cleared on uninstall, and can be limited to trusted extension contexts.
