# Concurrent Workspace and external browsers

ZenX keeps its Thread-owned Workspace browser available when the user enables an external browser connection. This change builds on the human takeover and fresh-observation return contract in [browser-human-control.md](browser-human-control.md). It does not change those controls or the native navigation-completion fence.

## Routing and permission boundaries

The process-local Browser backend registry holds two independent capability packages:

- `browser_workspace_*` addresses the shared Workspace browser.
- `browser_connected_*` addresses only the explicitly enabled external connection.

Both namespaces are generated from the existing Browser schemas; there are twenty tools in the single discoverable Browser package. This deliberately uses the Host's existing tool-name approval key rather than introducing argument-dependent permission policy or silently reusing legacy approvals for a different backend. Both namespaces are new: historical `browser_*` approvals are not migrated, including approvals created when the old selected provider was an external browser. Under approval-based policy each backend requests independent approval. Manifest permission descriptions are metadata; actual admission remains the existing Core tool-name policy. Full-access policy remains the user's existing explicit policy, not an additional gate imposed by this feature.

Tool API migration is explicit: old `browser_*` calls fail after a successful concurrent upgrade rather than retrying on a new backend. The Agent must refresh the capability catalog and list/inspect using the new tool names; old tab and observation references are not redirected.

Start each backend with its `list_tabs` tool. Results include `backendId`; tab, observation, target and continuation references are backend-qualified and must be passed unchanged to the corresponding namespace. Separate provider sessions, observation presentation caches, native targets, latest-observation validation and live subscription generations prevent collisions or delayed responses from redirecting work. A missing external provider fails explicitly and never falls back to Workspace. Closing an external session detaches ZenX and leaves the user's tabs and profile intact; closing a Workspace session also preserves shared pages. Workspace takeover still blocks mutations, and return still requires a fresh observation, including for navigate and close.

The ordinary settings page offers an additional external connection, rather than an exclusive provider selector. The legacy `browserMode` profile field is retained for compatibility: `user-session` now opts in to the additional backend. The external opt-in takes effect after restart. An explicit developer `ZENX_BROWSER_MODE=isolated` continues to select the legacy isolated provider path; `user-session` uses coexistence.

Provider upgrades are transactional: the committed runtime/backend and captured capability generation stay live until the new profile Catalog commits. Corrupt archives, runtime-admission failure and Catalog-save failure leave the old route intact. Restarting with an explicit isolated selector first restores the committed concurrent generation from the app-owned Workspace resource, then switches only through that transaction. After commit, the previous provider remains alive until its exact Supervisor generation has drained prepared calls, captured Host leases and dispatched operations; completed and failed operations keep their actual outcomes. The Host observes that existing retirement signal rather than introducing a second lifetime counter. Retiring a shared Workspace capability then releases only its own opaque session leases; it cannot close another generation’s sessions.

## Chrome and Edge setup

The user chooses Google Chrome or Microsoft Edge in Browser settings before explicitly registering or removing that browser's native host. Merely choosing a browser writes nothing. Registration and discovery remain separate for each browser:

- Chrome: existing Chrome native-messaging locations.
- Edge on Windows: `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.zenx.chrome_bridge`, with a separate Edge manifest file.
- Edge on macOS: `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/`.
- Edge on Linux: `~/.config/microsoft-edge/NativeMessagingHosts/`.

Only the bundled unpacked extension's exact keyed origin is allowed. There is no wildcard, store-origin guess, cookie export, profile migration or automatic registration. This supports the bundled unpacked extension workflow; an independently published Edge Add-ons extension may have a different ID and is not implicitly trusted.

The user loads the extension through `chrome://extensions` or `edge://extensions` and explicitly clicks it to connect. Existing browser-wide consent, lazy debugger attachment, narrow CDP command allowlist and disconnect semantics remain intact. A second native connection is rejected with a readable error, leaving the first connection, its tabs and pending commands untouched. The user must disconnect the current extension before connecting a different external browser. This first implementation supports one external connection. Simultaneous Chrome and Edge connections are a follow-on change requiring instance-scoped permission admission and bridge routing; this base does not claim that capability.

## Evidence and limits

Automated tests cover native-ID collisions, cross-backend reference rejection, independent latest-observation invalidation and session closure, disabled-provider failure, separate remembered tool approvals, merged read-only target previews (including synchronous metadata, most-recent Agent activity across backends and explicit pinning), diff action references, failed/successful real-tarball profile migrations, generation-specific Workspace leases, registry startup, Workspace human takeover and fresh return, concurrent connection rejection preserving an in-flight command, explicit Edge UI registration, platform-specific paths, exact origin restriction and independent removal. Packaging parity compares the generated runtime manifest to the shipped concurrent variant.

Native Windows/macOS/Edge acceptance is separate from Linux unit or path tests. No native Edge result is claimed without a real Edge run. Tests use disposable user data and synthetic content; they do not authorize use of real accounts or sensitive browser state.

## Official references

- [Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger): debugger permission, explicit targets/session IDs and detach behavior.
- [Microsoft Edge native messaging](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging): OS-specific registration paths, exact allowed origins, stable-channel locations and extension-ID differences.
- [Port Chrome extensions to Edge](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/port-chrome-extension): native messaging origin requirements.
- [Electron webContents](https://www.electronjs.org/docs/latest/api/web-contents): native page and navigation ownership, as preserved by the prerequisite handoff implementation.
