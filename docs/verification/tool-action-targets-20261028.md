# Tool-result destination actions

Scope: issue #562. Links are derived from native canonical tool receipts and existing trusted model-reference bindings, not names, message body URLs or code. A send receipt's exact message identity now survives compact model projection as a short `message` reference. No native ID is added to model text. Canonical child calls made through `run_code` use the same projection; the parent code/output is never interpreted as a destination.

## Verified

- Production App integration: exact delivered message receives focus and scroll selection, while an identical-text neighbor does not. Destination history is opened, live following pauses, and the action remains separate from tool-detail disclosure.
- Missing, queued and cancelled destination messages retain the source and show distinct feedback. Existing archived, denied, remote and stale-navigation safeguards remain in force.
- Trigger create/update results open the existing plugin tab and exact definition, including when that definition belongs to another Thread. Same-label definitions are not interchangeable. Viewing executes only existing read commands; no trigger save/run or message resend occurs.
- Native and web TypeScript checks pass after building the plugin SDK.
- Full `app-project-picker-interaction.test.ts`: 102 passing.
- Tool target, model facade, ThreadView component and reading-state suites: 141 passing.
- Existing message-source focused regression suites: 20 passing.
- Changed-file Prettier and `git diff --check` pass.

These are focused checks, not a claim that the repository-wide aggregate check or native Electron acceptance ran.

## Synthetic visual fixture

Build:

```sh
node apps/zenx/scripts/build-tool-action-targets-preview.mjs /tmp/zenx-tool-action-targets-preview
```

The self-contained `tool-action-targets.html` uses actual `ThreadView`, tool-action links, exact-message focus and `TriggersPanel` with synthetic receipts and definitions. Its CSP forbids network connections. It contains no Host, credentials, private data, persistent state or live mutations. This is not the production App router; the App behavior is covered separately above.

Capture:

```sh
node apps/zenx/scripts/capture-tool-action-targets-preview.mjs /tmp/zenx-tool-action-targets-preview
```

The capture script reuses the repository's existing temporary-profile Chromium fixture helper (which disables the browser sandbox) and checks English/Chinese actions, exact message focus, exact trigger prompt, read-only commands and narrow-width overflow. The fixture built successfully, but local capture did **not** run successfully: Chromium's local socket was blocked with EPERM; one permission-escalated retry failed before execution because the runtime could not create its denied `/home/agent/.codex/sessions` mount. No denied-path access was requested or performed. No screenshot is claimed verified. Run capture in an approved synthetic preview/CI environment and visually inspect the resulting screenshots before UI merge acceptance.
