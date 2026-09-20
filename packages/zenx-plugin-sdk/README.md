# @zenx/plugin-sdk

Public ZenX Plugin Package v2 contract for repository and external plugin development. It contains:

- TypeScript types for the v2 manifest, process runtime ABI, Host SDK v1, and Generic UI SDK v1.
- `zenx.plugin.schema.json` plus the matching runtime validator.
- `runProcessPlugin` for a minimal JSONL process runtime. Each tool receives its input plus an invocation context containing the Host call metadata and an `AbortSignal`; Host `cancel` and `close` abort active calls, and settled cancelled calls emit no result.
- `createFixturePluginHost` for in-memory SDK tests. Its `startTurn` operation always rejects because the fixture does not own Agent, Thread, or Turn authority.
- The `zenx-plugin create`, `dev`, `validate`, and `pack` commands.

## Package contract

A plugin is an ordinary npm package. `package.json#zenx.plugin` contains a safe package-relative path to its v2 manifest:

```json
{
  "name": "example-plugin",
  "version": "0.1.0",
  "zenx": { "plugin": "./zenx.plugin.json" },
  "dependencies": { "@zenx/plugin-sdk": "^0.1.0" }
}
```

The manifest `id` is the stable plugin identity and its `version` must equal the npm package version. Process and bundled runtime entries must resolve to files inside the package. `mainDocument` remains the inline model instruction, while an isolated UI bundle `entry` remains its iframe HTML document; neither is reinterpreted as a filesystem path.

## Commands

```sh
zenx-plugin create ./example-plugin --name example-plugin --id example-plugin
ZENX_PLUGIN_DEV=1 zenx
zenx-plugin dev ./example-plugin --target <ZenX-userData>/runtime/plugin-dev.json
zenx-plugin validate ./example-plugin
zenx-plugin pack ./example-plugin
```

`create` writes a runnable process plugin with only public SDK imports. `dev` first runs the same package validation, then asks one explicitly developer-enabled ZenX target to apply its canonical `dev-link` profile transaction and reload only that plugin instance; the SDK never writes Catalog or profile files. Client, request-body, interruptible package mutation, runtime admission, and target projection waits are bounded, with the client deadline kept longer than the Host's interruptible deadline. Before the durable Catalog replace, disconnect or expiry aborts and settles pnpm staging. Immediately before that single replace, the Host synchronously checks cancellation and enters a commit fence: its transaction timer is cleared, disconnect and shutdown no longer interrupt the mutation, and shutdown waits for save plus the existing non-fallible publish. A rejected save still reports failure with the prior Catalog authoritative; a successful save remains committed even if the caller disconnected. Post-commit projection has its own bound and is reported as committed-but-reload-failed. The private target descriptor exists only while that Host instance is running. `validate` checks current package metadata, manifest v2, identity, compatibility, runtime/tool/UI relationships, and package-contained runtime paths. `pack` runs that validation first and then delegates unchanged archive semantics to `npm pack --json`; it does not implement a ZenX archive, registry, dependency solver, or publisher.

The fixture Host keeps query, UI, and storage behavior in memory. Tests using it do not read or write ZenX user data.

### Thread side-panel tabs

Declare a `contributions.panels` entry with `id`, `title`, `surfaceId`, and optional
`order`, and a matching `ui.surfaces` / `ui.bundles` definition. ZenX places the
surface as a peer content tab in the selected Thread's right panel. Registered panels appear in the `+` type picker; the Host does not add a Browser/Files category layer above plugin content. The
existing UI SDK supplies `context.threadId`, theme, handles, and commands;
isolated HTML stays inside an `allow-scripts` sandbox. The separate Host-owned
frame document supplies its own restrictive CSP so the parent renderer never
needs to allow inline plugin scripts. Panel selection is local,
transient UI state, not Thread history. A disabled/uninstalled plugin loses its tab.

Bundled runtimes can request their own panel using the Host SDK:

```ts
await sdk.ui.panels.open({ panelId: "preview", threadId: invocation.threadId });
```

Process plugins using the public runner receive a Thread-bound helper:

```ts
runProcessPlugin({
  pluginId: "notes",
  packageVersion: "1.0.0",
  tools: {
    show: async (_input, invocation) => {
      await invocation.ui.panels.open("preview");
      return { output: "Requested the Notes preview panel." };
    },
  },
});
```

The raw process ABI operation is `ui.panels.open` with `panelId` and `threadId`.
The Host binds plugin identity and checks the panel against active contributions.
It does not create or resume a Turn or navigate away from the user's current
Thread. A request for a background Thread is shown when the user selects that
Thread. Missing panels, invalid Threads, and unavailable windows fail explicitly.
Success acknowledges dispatch, not user visibility or acceptance. Calls should
be awaited within their invocation; cancellation releases pending helper calls.

### UI theme contract

Generic UI SDK v1 includes optional `appearance` with `version: 1`, a read-only
`variables` map of ZenX semantic CSS custom properties, and `reducedMotion`.
Existing `theme` remains `light` or `dark`. Trusted surfaces inherit the host's
control styles; isolated surfaces receive the same variables and a small base
stylesheet for buttons, fields, focus and reduced motion, while retaining the
`allow-scripts` sandbox without same-origin access.

Isolated surfaces receive `zenx-plugin-ui:change` when context/theme changes.
Read the current `window.zenxPluginUi` getters (or the event's `detail.sdk`) to
update custom UI. Theme changes do not replace the document or clear local form
input. Bundle replacement still creates a new document and invalidates replies
to the old frame. Appearance is display information, never runtime authority.
