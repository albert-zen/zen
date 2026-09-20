# Optional Cockpit component experiment

This is an ordinary external process plugin; it is not installed or enabled by default. Start/build ZenX with `RENDERER_VITE_COCKPIT=1` to show Cockpit.

Before the public SDK is published, make a self-contained standard tarball from the repository root:

```sh
npm run build --workspace @zenx/plugin-sdk
node apps/zenx/scripts/pack-cockpit-component.mjs /absolute/artifact-directory
```

Use **Marketplace → Advanced source → tarball** with the reported `.tgz`. The packaging helper copies the existing SDK runtime into this artifact, needs no registry download and leaves its staging source beside the tarball for inspection. It does not modify the example source or any profile. After SDK publication, this source can also be installed through the ordinary local-copy flow with its declared public dependency.

Ask the Agent in an existing task: “Inspect the canonical Item IDs in this task, then use cockpit_component_publish to author a compact interactive review of the evidence. Cite only prior Items in this Thread. Use a button to expand the source excerpt, fetched with sdk.handles.read. Do not change model, effort or permissions.”

The tool saves HTML as structured content in the normal tool result. Select the task in Cockpit, inspect its sources, then click **Open isolated component**. Reloading the view recovers the same component from that result. Without Cockpit, the regular transcript retains the text/JSON fallback.

Publication is not evidence that its conclusions are correct. The Host verifies IDs and lineage, not semantic truth. The existing iframe sandbox forbids same-origin access, and its CSP blocks network. Host commands/navigation are denied. Scripts may still exhaust browser resources; this is not a separate-process availability sandbox.
