# Reproduce sustained native UI journeys

These QA-only scripts prepare an isolated ZenX profile and run the normal built
native application with a controlled local FakeModel. They do not change
production source or built files. They are for genuine native UI inspection of
streaming, reading-position restoration, pending queue/steer, interruption, and
send recovery. There is no DOM injection or screenshot automation.

## Prepare a fresh root

Requirements: the selected checkout's development dependencies, Node with `tsx`,
a current ZenX build, and an already-installed native Electron executable.
Use the actual executable, not a wrapper that downloads a missing binary.
The recorded native captures used Electron 43.2.0.

From the selected repository root:

```sh
REPOSITORY="$PWD"
FIXTURE="$REPOSITORY/docs/ui-quality/scripts/live-native"
QA_PARENT="$(mktemp -d)"
QA_ROOT="$QA_PARENT/live-native"
ELECTRON="/absolute/path/to/installed/electron"

node --import tsx "$FIXTURE/seed-live-native-journeys.mts" "$REPOSITORY" "$QA_ROOT"
"$FIXTURE/launch-live-native.sh" "$REPOSITORY" "$QA_ROOT" "$ELECTRON" --check
"$FIXTURE/launch-live-native.sh" "$REPOSITORY" "$QA_ROOT" "$ELECTRON"
```

On macOS, the Electron executable is normally inside
`Electron.app/Contents/MacOS/Electron`. On Linux, select the installed `electron`
binary. The shell launcher needs Bash and accepts repository, seeded root, and
Electron paths explicitly. It resolves its companion files relative to itself.
It does not require Node to launch Electron. The optional `--check` mode does
need Node; if it is not on the terminal PATH, set `ZENX_QA_NODE_BIN` to its absolute
executable path. No machine-specific PATH is embedded in these scripts.

The seed refuses **every existing root**, including an empty one. It creates
synthetic histories through public hosted App Server APIs and native WebSocket
requests, validates the profile through the production schema/config functions,
closes the host, and writes `seed-result.json` only after assertions pass.
The manifest records repository, commit/tree, whether the source worktree was
dirty, thread identities, receipts, and QA substitutions. A recorded commit/tree
alone does not prove a dirty checkout or an old build matches that revision.
Record the build fingerprints used for each capture separately.

For a different integration checkout, seed a different root with that checkout
as the first argument. The launcher requires the repository and root to match
the successful manifest. Do not open the same root in two hosts at once. Never
point this fixture at an existing user or capture profile, copy a running root,
or terminate a different profile's application.

## What is real and what is injected

- The application, renderer, native protocol, queue/steer operations, canonical
  admission, persistence, and interruption behavior are production code.
- The QA preload replaces only its own host process's exported
  `FakeModel.prototype.stream` to control timing and failure. It checks the
  isolated marker, matching repository/data directory, fake-only profile, and
  exactly one expected App Server bundle/class set. A mismatch fails explicitly.
  Ordinary non-QA input uses a fixture-local echo, not production FakeModel's
  command parser. The adapter rejects `!shell` and `!tool` at the start of any
  text line/part and emits only text/usage events for its supported paths.
  This guard belongs to the portable version. Earlier external capture fixtures
  delegated ordinary input to production FakeModel; their screenshots do not
  establish this newer command-rejection behavior.
- Public send methods are wrapped **before admission** for delayed or rejected
  inputs. This does not fabricate accepted user input or durable delivery state.
- The seed's faster timing is only for CLI assertions. Native launch uses one
  paragraph per second for up to ten minutes, a 15-second admission wait, and
  three-second failure/rejection delays.
- The documented seed and QA adapter do not require provider credentials or use
  a remote provider. This adapter never produces tool-call events, but that is
  **not a guarantee of no effects elsewhere in the application**. Read-only
  thread defaults and approval prompts are not global isolation. The fixture
  does not prevent manual profile, plugin, tool, or permission changes and does
  not confine other application/OS actions. The native app creates its normal
  ephemeral local IPC authentication. Never include those token files or the
  full runtime profile in public artifacts.
- The launcher strips inherited credential-like environment variables and online
  provider/acceptance overrides, uses an isolated browser profile, and blocks
  non-loopback requests in Electron's default session. This is **not an OS
  firewall**, nor a claim that every possible child process is network-contained.
  Do not configure external providers or plugins in this disposable root.
- Hardware acceleration is disabled only in the QA launcher, matching the
  cloud-desktop captures that otherwise produced corrupt surfaces.

## Native actions

Use the normal composer and controls with approved native capture tooling.
Send one QA command per message, without mentioning other command names.

### Stream, hold, and return to live

1. Open **Live stream · hold and follow · QA**, which has 30 completed turns.
2. Send `QA_STREAM` using the normal starting mode. At the bottom, verify that
   several numbered live checkpoints advance while the response grows.
3. Scroll upward to a distinctive old **Reading checkpoint**. Wait at least ten
   seconds. Capture the same old content while `live-controls.jsonl` records
   increasing emitted checkpoints.
4. Switch to another thread and back while streaming. Check restoration of the
   held reading position. Repeat with sidebar collapse or a narrow window.
5. Use **Back to live** or return to the bottom. Verify multiple new checkpoints
   remain in view as following resumes.
6. While streaming, choose **Queue** and **Steer** and send ordinary follow-up
   text. These pending inputs originate from actual native UI actions.
7. Press **Stop**. Verify pending inputs remain. Expand **Activity** to inspect
   the retained partial response.

`QA_HOLD` keeps the current sample open without growing paragraphs, for up to ten
minutes or until Stop. It is useful when inspecting pending controls without
continuous transcript movement.

### Persistent pending and provider failure

- **Held pending · steer and queue · QA** begins with a real interrupted turn,
  two held steer inputs, and three queued inputs. Capture before changing them.
  Verify navigation, group expansion, recall, queue reorder/edit/cancel, and a
  complete QA app restart as appropriate. The CLI seed already verifies the
  pending projection after host close/reopen.
- **Provider failure · held steer · QA** contains a real failed turn with one held
  steer, generated by a synthetic nonrecoverable provider error. On a fresh QA
  thread, send `QA_FAIL` and then an ordinary Steer input within three seconds to
  reproduce it through the UI. Capture before Continue or a new normal input.
- Queue/steer operations are real and persist in this disposable profile. Prepare
  another fresh root when an untouched comparison is needed.

### Admission wait and conservative delivery recovery

1. Open **Admission and retry · QA** and send
   `QA_ADMIT: inspect the admission wait`. For 15 seconds the request is held
   before the real public call. Capture the local pending row, then verify a
   single accepted input appears after release.
2. Send `QA_REJECT: inspect delivery recovery`. The fixture rejects after three
   seconds with `invalid_input` before committing the message.
3. **Do not expect a definitive rejected label in the native UI.** In recorded
   native IPC captures, the `ZenXProtocolError` envelope produces **Delivery not
   confirmed**. **Check delivery** remains conservative. This differs from the
   fixture's known uncommitted injection and the direct CLI receipt assertion.
4. **Add back to draft** preserves the original recovery copy. Edit the draft,
   remove `QA_REJECT`, and send different normal text. Verify the edited input is
   accepted once. The original unknown-delivery recovery copy remains until
   explicitly dismissed; an edited send does not prove or dismiss its outcome.
5. Navigate away/back to check owning-thread behavior. Local pending-send
   presentation is not a durable accepted-input claim and need not survive a
   complete app restart. Repeating the literal command repeats the injection.

### Interrupted output is retained in Activity

The adapter emits text deltas, not canonical assistant-message commits. On abort
or failure, production `src/runtime.ts` commits accumulated text with
`incomplete: true`. `src/domain-journal.ts` routes that incomplete observation to
Trace rather than completed semantic model history. The renderer's
`turn-projection.ts` gives only completed turns a final answer; interrupted
response content is in folded Activity history. `ThreadView.tsx` exposes it when
Activity is expanded. This is covered by the existing “interrupted partial
answer stays folded” test in `agent-runtime-interaction.test.ts`.

Accurate capture wording: **Stop preserved pending inputs and retained partial
output, accessible through Activity.** A collapsed view is not evidence of lost
output, and this fixture does not demonstrate a product bug there.

## Validation and artifacts

Files in this directory:

- `seed-live-native-journeys.mts`: fresh-root canonical seed and CLI assertions.
- `live-qa-controls.mjs`: controlled text-only adapter and pre-admission behavior.
- `live-qa-controls.test.mjs`: ordinary-input, typed-part command rejection, and
  supported-command tests; the original FakeModel stream must never be invoked.
- `live-qa-preload.mjs`: isolated built-host injection.
- `launch-live-native.cjs`: native wrapper; its `--check` branch is read-only and
  does not load Electron or start a host.
- `launch-live-native.sh`: portable explicit-path launcher.

The root contains `seed-result.json`, `seed-controls.jsonl`, synthetic workspace
files, data, and its disposable profile. Native runs add `live-controls.jsonl`.
Review artifacts and redact normal local authentication before sharing.

Useful non-UI checks, from the selected repository:

```sh
node --check "$FIXTURE/live-qa-controls.mjs"
node --check "$FIXTURE/live-qa-preload.mjs"
node --check "$FIXTURE/launch-live-native.cjs"
bash -n "$FIXTURE/launch-live-native.sh"
node --test "$FIXTURE/live-qa-controls.test.mjs"
node --import tsx --test test/steer-recall-lifecycle.test.ts apps/zenx/test/host-profile.test.ts
```

`--check` verifies marker/root/repository agreement, fake-only profile, and file
references. Its fake-profile check does not audit or disable plugins/tools,
prevent later configuration changes, or establish OS-level isolation. It does not repeat the production schema checks done by the seed,
instantiate a host, test rendering, or establish actual native scroll positions.
CLI and source checks are not screenshots or visual acceptance. Online provider
behavior, authentication, paid-model quality, external plugins, and external
side effects remain outside this fixture's coverage. Reviewers should judge the
actual native evidence without a supplied score threshold.
