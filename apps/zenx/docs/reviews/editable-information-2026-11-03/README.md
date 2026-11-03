# Editable information component review

These PNGs show the **actual production editable information, Board and information host components with synthetic in-memory ports and an outer conversation scaffold**. They are not the complete ZenX App, native Electron, real Host/provider acceptance, or T3 reference screenshots. The separate question card is a synthetic attention-slot probe, not the production Asking implementation.

The supported cloud browser operated the controls through the managed Sites preview relay. `source.json` binds the component, style and fixture sources by SHA-256. The external JavaScript entry avoids the relay's live-reload HTML insertion inside bundled isolated-document strings.

- 01: Default Thread components, including explicit unavailable PR/artifact providers.
- 02: Customization controls.
- 03: Retained concurrent-edit conflict requiring explicit reapply.
- 04: All widgets hidden; Asking attention remains visible.
- 05: Two independent Board bodies with identical authored ID/revision; only the second field changed and the Composer draft stayed untouched.
- 06: Dark customization.
- 07: Narrow **workspace allocation** with dismissible popover. This is not a resized mobile viewport.
- 08: Empty Room, no invented member source.

The local standalone Chromium capture attempt failed with Unix socket `EPERM`, including the approved escalated retry. It is not reported as passing. `acceptance.json` records the distinct cloud-browser component checks. Complete native acceptance remains the existing disposable full-App Electron driver and must be rerun against the integrated UI/Asking source.

Rebuild the component fixture:

```
node apps/zenx/scripts/build-information-layout-preview.mjs /tmp/information-layout-preview
node apps/zenx/scripts/capture-information-layout-preview.mjs /tmp/information-layout-preview
```

The second command requires an existing Chrome executable with the repository's disposable CDP fixture. It was blocked in this sandbox. For supported managed preview, serve the generated `index.html` plus `information.js` through the documented Sites preview command; it remains local-only synthetic QA.
