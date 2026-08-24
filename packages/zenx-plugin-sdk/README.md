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
