# Generic plugin and secure IM onboarding QA

Reviewed source: `d4502538a4673f543650e55e8d68c431939bbac8`, based on main
`42b74727d6d613929cf8b46fb0a17cbe6aa8542a`. The later evidence commit changes
only this report and screenshots. Three bounded security/lifecycle review passes
completed; the final frozen-source pass found no actionable blockers.

## Product flow

- Any Agent can inspect ordinary plugin lifecycle readiness through
  `zenx_plugin` with `operation: "readiness"` and explicit `pluginIds`.
  Missing, disabled and unavailable plugins produce install, enable and repair
  actions. This read-only operation grants no permissions or tool disclosure.
- PAW consumes declarative preset requirements. A fresh profile's existing
  default plugins are ready; creating a PAW needs a name and working conversation,
  without a second tool-permission path or an automatic recurring paid check.
- The ordinary IM plugin can save nonsecret preparation and report local
  prerequisites. Its own trusted local form handles provider-declared fields,
  write-only credentials and explicit Save. Save does not connect.
- Credentials use the existing encrypted local vault. Linux plaintext fallback,
  unknown backends and unavailable encryption fail closed. Values are absent from
  model tools, readiness results and user-facing diagnostic text.
- Prepare runtime uses the admitted locked project in an IM-owned runtime
  directory. It needs installed official `uv` and existing private SDK repository
  access. It neither enrolls an account nor starts a consumer.
- Connect requires an explicit single-consumer confirmation. A started Gateway
  is described as local process state; actual bot message delivery still needs a
  real send/receive check by the user.

## Native app evidence

The actual built ZenX Electron app ran on the cloud Linux desktop with an
isolated synthetic profile and local fake conversation backend. No external IM
account or model was contacted. Screenshots are raw JPEG captures.

1. [PAW ready defaults](01-native-paw-ready.jpg): the native creation dialog
   shows ready preset requirements, one name and working-conversation selection.
   Escape closed it without creating a PAW.
2. [Native IM prerequisites](02-native-im-prerequisites.jpg): after installing
   the trusted bundled IM plugin in this isolated profile, the actual local form
   showed runtime preparation and the unavailable OS credential protection.
3. [Native fields and blocked Save](03-native-im-fields-blocked.jpg): declared
   fields, write-only secret field and the reusable workspace chooser were
   visible; Save remained blocked.

No credential was entered or saved, runtime prepared, or IM Connect performed in
the native app. The cloud Linux OS-protection limitation was not bypassed.

## Renderer mock evidence

These captures show the reviewed renderer and actual plugin-page composition in
an offline Electron fixture. Its native IPC, status and SDK checks are mocks.
The values `demo-user`, `123456`, `demo` and `/Users/demo/work` are synthetic.
No vault, SDK installation, Gateway, network or account operation occurred.

4. [Mock saved preparation and readiness](04-mock-saved-readiness.jpg): channel
   Save cleared the password input; preparation Save and the read-only check left
   the mock consumer disconnected.
5. [Mock explicit consumer confirmation](05-mock-explicit-confirmation.jpg):
   Connect is initially disabled until the user checks the consumer confirmation.
   Escape cancelled the dialog and left the mock disconnected.
6. [Mock dark form](06-mock-dark-channel-form.jpg): the same declared fields and
   prerequisite information in dark appearance.

Narrow-window visual QA is unverified: the cloud window manager did not apply the
bounded resize attempts. DOM interaction coverage passed; it is not a substitute
for a narrow-layout screenshot. Windows and macOS native credential integration
and real QQ/Telegram/Feishu delivery are also unverified. Weixin's enrolled
private state-directory prerequisite is shown explicitly; this form does not
invent its enrollment schema.

Both native and mock app launchers were stopped after QA, and the terminal prompt
was restored. No QA profile, launcher, log or credential file is included here.

## Validation

- Final focused ZenX suite: **60/60 passed**, including UI, secure storage,
  sender trust, runtime lifecycle, PAW defaults, generic discovery/readiness and
  process-tree containment.
- Actual hosted Agent/wire regression suite: **29/29 passed**.
- Settings interaction recheck with a 4 GiB Node heap: **66/66 passed**.
- IM plugin package: **34/34 passed**, manifest validation passed.
- Python IM suite: **102/102 passed**; Ruff and formatting passed.
- Authenticated fake IM/ZAS integration passed through the direct Node loader.
  This exercises synthetic transport integration, not live provider delivery.
- ZenX Node/web typechecks, final prepared build, trusted resource packing,
  changed-file formatting and `git diff --check` passed.

The broad ZenX run was **not fully green**: 1,602 tests, 1,582 passed, 9 failed,
11 skipped. The changed schema golden was corrected and rechecked. Five npm
cache failures passed when serially rechecked with a writable cache. The Settings
heap failure passed with the larger heap. The remaining two dev-link timing
failures reproduced on untouched main `42b7472`: “dev abort after runtime admission
begins rolls back before Catalog commit” and “dev Catalog save rejection after
the fence reports failure without a commit”. The packaging/profile/subagent
serial recheck passed 34/36, with those same two baseline failures.

Representative final commands (from `apps/zenx`):

```sh
node --import tsx --test --test-concurrency=1 \
  test/imzenx-ui.test.ts test/imzenx-setup-service.test.ts \
  test/imzenx-runtime-preparation.test.ts test/imzenx-setup-ipc.test.ts \
  test/imzenx-lifecycle.test.ts test/imzenx-paw.test.ts \
  test/plugin-discovery.test.ts test/plugin-readiness.test.ts \
  test/assistant-room.test.ts test/assistant-room-ui.test.ts \
  test/assistant-workspace.test.ts test/secure-local-encryption.test.ts
node --import tsx --test \
  test/capability-tool-executor.test.ts test/host-messages.test.ts
NODE_OPTIONS=--max-old-space-size=4096 \
  node --import tsx --test test/settings-interaction.test.ts
```
