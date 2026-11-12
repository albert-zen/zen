# Native Agent / Information QA

This fixture prepares a **new isolated profile** using the unchanged production
FakeModel and the real bundled Subagents plugin. It runs the production tool
facade and native Core APIs, rather than fabricating canonical history or
injecting renderer DOM. Text and tasks are synthetic. No real autonomous research,
remote model, credentials, or external tool actions are claimed.

## Prerequisites

Use an existing repository installation with built plugin SDK, bundled Subagents
tarball, and a current native ZenX build. Use an already installed Electron
executable; this launcher does not download Electron. Run the commands from the
repository root. Rebuild through the repository's normal workflow when the native
output does not correspond to the source under review.

## Seed and launch

Choose a root that does not exist. The seed refuses every existing root, including
an empty directory. Do not point it at an active app profile. The following
example allocates a new parent directory and lets the seed create its `profile-qa`
child:

```sh
REPO="$(pwd -P)"
TOOLS="$REPO/docs/ui-quality/scripts/agent-information"
QA_PARENT="$(mktemp -d "${TMPDIR:-/tmp}/zenx-agent-information.XXXXXX")"
ROOT="$QA_PARENT/profile-qa"

node --import tsx "$TOOLS/seed-agent-information.mts" "$REPO" "$ROOT"
node "$TOOLS/launch-agent-information.cjs" --check "$REPO" "$ROOT"

# Set this to the existing native executable, not a package-download shim.
ELECTRON=/absolute/path/to/installed/electron
bash "$TOOLS/launch-agent-information.sh" "$REPO" "$ROOT" "$ELECTRON"
```

`--check` is read-only and starts neither Electron nor an App Server. It checks
build-file presence, not build/source equivalence. The normal launcher imports
`apps/zenx/out/main/index.js`; it does not patch the model, runtime, renderer, or
DOM. It uses this root for userData/sessionData and `ZENX_DATA_DIR`, clears inherited
provider and prior timing-fixture overrides, forces isolated browser mode, and
sets pnpm offline. It blocks non-loopback requests from the default renderer
session. This is not an OS firewall. Hardware acceleration is disabled as a
cloud-desktop QA accommodation. Normal startup may install additional bundled
plugins within this isolated profile.

## What the seed verifies

- A real bundled `zenx-subagents` package is installed and its panel is admitted.
- The production HostToolBundle/model facade forwards two real create calls and
  one child-to-parent send to the installed plugin.
- Plugin Core requests traverse the production loopback WebSocket protocol client.
- Parent, fresh child, archived fork and their canonical history are native facts.
- The inbound Agent message identifies the child's exact canonical send tool call.
- Closing and reopening the host and plugin restores those relationships and facts.
- The host profile validates and contains only a local fake provider.

The in-process forwarding of HostToolBundle capability messages is a seed-only
transport accommodation. Seeding alone does not exercise Electron IPC. The native
launch and operator journey exercise the normal app after the persisted seed.

There is no `agent_spawn` implementation in the inspected checkout. The production
equivalent used here is `zenx_subagents_create`.

## Generated evidence

The new root contains `seed-result.json`, `capability-receipts.json`,
`native-port-calls.json`, `plugin-snapshot.json`, `thread-snapshots.json`, and
`restored-plugin-query.json`. Exact generated IDs are in `seed-result.json`.

The `profile/` and `data/` directories are private, disposable QA state. Do not
commit profiles, installed package generations, canonical logs, or raw Trace.
Publish only the intended synthetic fixture code, scoped metadata and explicitly
reviewed screenshots. A failed seed should be retained for diagnosis, then rerun
only in another new root after correcting its cause.

## Native acceptance journey

1. Select pinned **Agent Information · native plugin QA** and open Information.
   The Subagents card should show **QA reviewer · native child**, Idle, an initially
   Hidden sidebar control and Show archived.
2. Click the child's sidebar switch on. Confirm the child appears in Projects and
   Recent without selecting another conversation. Use Space to switch it off;
   confirm the entries disappear and visible focus remains on that control.
3. Click the child row. Confirm the normal companion conversation opens and shows
   the real `zenx_subagents_send` call and successful result. Close its tab normally.
4. In the parent, find **Synthetic reviewer report** and its **From QA reviewer ·
   native child** link. Activate that link and confirm the same child becomes the
   main conversation. The local link targets the sender Thread, not an exact tool
   Item anchor.
5. Open Information on the child. It has no children, so the parent's lineage card
   must not leak into this owner.
6. Return to the parent. Select Show archived and confirm **Archived reviewer ·
   native fork** appears with Archived status. This checks visibility, not execution
   of any forked task or opening the archived conversation.
7. Open the workspace beside the parent to reduce its allocation. Reopen Information
   and verify the normal popover stays usable. Press Escape; confirm it closes and
   focus returns to the Information toggle.
8. Capture actual native screenshots and label them **synthetic local FakeModel
   data, real installed plugin and native history**. Record any anomalies separately.
   Close the isolated QA app when done.

## Focused automated checks

```sh
node --import tsx --test \
  apps/zenx/test/subagents-capability.test.ts \
  apps/zenx/test/subagents-ui.test.ts \
  apps/zenx/test/message-source-navigation.test.ts \
  apps/zenx/test/plugin-information-layout.test.ts
node --import tsx --test --test-name-pattern='child Sidebar visibility' \
  apps/zenx/test/settings-service.test.ts
```

The recorded preparation run passed 48 tests in the first command and 4 in the
second. These do not replace native screenshots or the repository's full checks.
See `../../checkpoints/native-agent-information.md` for the inspected native run,
build limits, and retained diagnostic anomaly.
