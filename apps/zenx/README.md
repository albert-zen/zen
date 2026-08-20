# ZenX

## Desktop shell policy

Projects are ZenX host-profile workspace entries grouped with ZAS native Thread
`cwd` by canonical filesystem identity; symlink/junction aliases share one
Project while the configured user-selected path remains its display path. The
projection resolves the nearest existing ancestor asynchronously and falls back
to the lexical absolute path when realpath is unavailable, so missing or denied
paths remain usable. It publishes configuration refreshes latest-wins and
re-canonicalizes immutable per-operation snapshots, so filesystem identity may
recover or change without becoming a permanently cached Project key. Projects
are not Core runtime objects. Add Project uses ZenX's read-only directory picker.
Removing an entry only changes the host profile and never deletes the directory,
its files, or Thread journals.
New Thread always carries an explicit configured Project `cwd`. The top-level
action reuses the last Project used for a Thread; if that record is missing or
the Project was removed, ZenX asks the user to choose and never falls back to
Documents or the process working directory.

Packaged Windows and Linux builds install no application menu, removing
Electron's default File/Edit/View/Window strip. macOS keeps a minimal native
application, edit, and window menu so standard system roles and text editing
shortcuts remain available; ZenX product navigation stays in the renderer.

ZenX is Zen's in-development Electron client. It hosts the same App Server used
by the CLI and keeps desktop-only configuration and orchestration outside Zen
Core.

Thread list product data is defined by ZAS's native `ThreadSummary` /
`CurrentMetadata` read model. Electron main queries it through the existing
host-local process boundary and preload exposes a typed IPC method. Codex Thread
DTOs remain compatibility-only protocol types; they do not define ZenX's product
model. The renderer and Agent self-control consume the same main-process Project
projection instance.

The renderer offers explicit Active and Archived Thread views. Active Threads
can be renamed or archived, and archived Threads can be opened and unarchived.
These actions use `thread/name/set`, `thread/archive`, and `thread/unarchive`
through the existing App Server client; the renderer never reads journals or
keeps a second Thread model. Archive is the reversible alternative to deletion.
The UI disables Archive while a Turn is active, reports query and mutation
failures in place, and leaves the running Turn and its settings unchanged.

## Run

```sh
npm --workspace apps/zenx run dev
```

Build the real ZenX application for the current platform with the same pinned,
integrity-checked provider assembly used by `smoke:packaged`:

```sh
npm --workspace apps/zenx run package:portable
```

The result is an **unsigned, unpacked portable directory**, not an installer or
a single-file executable. It is written below
`apps/zenx/.packaged/artifact/ZenX-<platform>-<arch>/`; keep that directory
together and start `ZenX.exe` on Windows, `ZenX.app` on macOS, or `ZenX` on
Linux.

Each packaging command builds a private output snapshot, assembles resources,
and runs Electron packager in its own `.packaged/runs/` directory, reusing only
SHA-256-addressed verified archive cache files. The Playwright browser archive
is pinned per platform in the same provider lock and its complete extracted
payload is covered by the final manifest. A completed directory replaces the
stable artifact under a per-target lock; a concurrent command for the same
target fails explicitly.

The development package identity remains `@zen/zenx`, while the portable
runtime identity is `zenx` and its packager product/display name is `ZenX`.
Consequently, Electron keeps their default profiles separate: on Windows they
are `%APPDATA%\\@zen\\zenx` for development and `%APPDATA%\\zenx` for the
portable app (with the equivalent `Application Support` / XDG config roots on
macOS and Linux). The Windows build does not currently set an explicit
AppUserModelID; the macOS packager default bundle ID is `com.electron.zenx`.
Packaging does not migrate, delete, or redirect either profile. Pass
`--user-data-dir=<new-path>` when you deliberately need an isolated profile for
testing; never point that option at an existing browser or ZenX profile.

The Windows packaged Project acceptance (`smoke:windows-projects`) launches
the real packaged ZenX shell and drives Add Project, default selection,
removal, and restart through a main-process acceptance hook that executes only
when its explicit isolated config environment parameter is present. The main
process consumes and removes that parameter before starting any child host. The
hook uses the real renderer and IPC without opening a debug port, verifies the
native application menu is absent, and confirms that removal preserves Project
marker files.

## Design reference

The reviewed [high-fidelity prototype](prototypes/high-fidelity/README.md) is a
static design and interaction reference with its own local preview instructions.
It is not production renderer code, product architecture, runtime behavior, or
build input.

The first window is onboarding. Choose an OpenAI subscription, an
OpenAI-compatible API provider, or the deterministic local demo. Saving restarts
the local host; existing Thread model settings remain authoritative in ZAS.

Host profiles live under Electron `userData` without credentials. Compatible
provider API keys are encrypted with Electron `safeStorage`; subscription OAuth
uses Zen's independent mode-0600 host profile. Neither is written to Thread
journals, App Server protocol history, or shell environment.

## Triggers and Rooms

The per-Thread Trigger rail can register one-shot or recurring timers,
`turn_completed` watches, Room mentions, and named signal conditions. `Scheduled`
lists every active trigger, recent history, Rooms, and a renderer-IPC signal
simulator for local testing. A hit persists an auditable occurrence with a stable
client message ID, then starts a normal App Server Turn. Failures remain visible
and are never silently retried.

The bundled `zenx-triggers` and `zenx-rooms` capability packages expose their
own separately permissioned read and write tools for Trigger
list/create/update/cancel/delete and Room list/create/rename/delete/member/post
operations. Both use the same Trigger/Room store and the same ordinary App
Server `turn/start` path; they add no protocol methods, Core Items, queue, or
transcript. A wakeup owns its original Room reply route, and Room deletion is
rejected while that route is nonterminal. Admission is bounded to 64 nonterminal
wakeups; the next wakeup produces one failed audit and no dispatch, while each
terminal outcome releases one slot.

Programmable Trigger predicates/actions are one-attempt local JSON programs with
bounded input/output, explicit timeout/cancellation, cwd/env, regex matching,
stable invocation IDs, and durable success/failure outcomes. A process restart
marks uncertain in-flight work failed and does not retry it.

A Room is shared transcription and routing, not an Agent Thread. Only an explicit
member mention with a matching trigger delivers Room content to that member's
Thread. Rooms support multiple unique member names/Threads and inject only a
bounded recent context window. Agent replies in the Room link back to their
source Thread and Turn. Thread watches similarly inject a bounded completed-Turn
snapshot rather than copying a second authoritative transcript.

## Capabilities

ZenX owns a capability registry outside Zen Core. Settings shows every bundled
or local package, its provider/platform metadata, requested permission scopes,
tool capabilities and interaction mode, instruction resources, and recent
in-memory audit projection. Granting or revoking a package restarts the local
host so the Agent sees exactly the currently authorized tool definitions.
Capability grants, per-call approval, and the execution sandbox remain separate
concepts. A host may impose a background-only execution policy without treating
that restriction as a missing grant.

Capability packages are also the installed-plugin unit. A manifest may declare
only controlled `pages` and `sidebar` contributions; the main-process registry
projects enabled contributions through the typed `window.zenx.plugins` preload
API and never gives a package DOM or router access. Enablement is persisted next
to grants in the same atomic capability configuration document, but remains a
separate field and meaning: disabling removes UI contributions and host tools,
then aborts and settles already accepted package executions before the serialized
App Server capability restart completes. Grant, revoke, and enablement mutations
share one ordered configuration boundary, so concurrent UI requests cannot lose
the last operation. Permission grants are retained and do not imply enablement.
Tool-only packages are valid and simply contribute no UI.

Triggers (`zenx-triggers`) and Rooms (`zenx-rooms`) are separate bundled
packages over the existing Trigger/Room service. Each contributes one page and
one Plugin-spaces Sidebar item. Disabling either package removes only its own
projection and tools; the Trigger/Room data model and canonical Turn delivery
remain unchanged.

### Bundled self-control provider

The `zenx-self-control` package is a bundled, cross-platform,
`background_safe` capability. It is hidden from the Agent until the existing
Capabilities UI grants its workspace-read and local-device-control permissions;
grant/revoke uses the same host restart behavior as every other package. Its
provider-valid tools are `zenx_projects_list`, `zenx_threads_list`,
`zenx_threads_create`, `zenx_threads_read`, `zenx_threads_status`,
`zenx_threads_rename`, `zenx_threads_archive`, `zenx_threads_unarchive`, and
`zenx_threads_send`. Archived Threads remain readable and are returned from
`zenx_threads_list` only when `archived: true` is requested.

Projects are bounded groupings derived from the configured workspace and
canonical Thread cwd metadata, not runtime objects. Reads expose bounded recent
Turn/item projections and omit command output. Create and send operations use a
narrow in-memory request port attached to the current `AppServerManager`, and
that port issues only typed `thread/list`, `thread/start`, `thread/read`,
`thread/name/set`, `thread/archive`, `thread/unarchive`, `turn/start`,
`turn/steer`, and `turn/replace` requests. `steer` and `replace`
require the expected active Turn ID; all sends require a stable client message
ID. Tool calls, results, interruption, and replacement remain auditable in the
canonical ItemLists and capability audit projection. Mutual `turn_completed`
relays are intentionally allowed; there is no blanket cycle ban or second
transcript/queue.

The bundled browser provider uses hidden Electron windows in a dedicated,
ephemeral Chromium partition. Its list/open/navigate/inspect/click/type/close tools
target one explicit `sessionId` and `tabId` through Chromium DevTools Protocol
(CDP) DOM evaluation, without
moving the OS pointer or activating a browser window. Inspection returns bounded
visible text plus opaque IDs bound to the latest tab/document observation, never
raw CSS selectors, cookies, storage, headers, or unrelated tabs. Actions
revalidate visibility, supported action, and semantic identity, then invalidate
the observation; navigation and close do likewise. Existing input values are
omitted, while text arguments dispatch normally regardless of password or
autocomplete metadata and remain ordinary canonical tool-call arguments. Sessions have hard
per-session/global tab caps plus explicit tab/session close tools.
`browser_close_session` destroys all session windows, awaits storage/cache/auth
cleanup, and advances the partition generation; reopening the same `sessionId`
therefore starts without the prior cookies or session storage. Generation state
exists only for active/pending sessions, so logical session bookkeeping is bounded.
User-browser attachment is a separate explicit opt-in mode. Start a supported
Chrome, Edge, or Chromium 100+ yourself with a loopback remote-debugging port,
open or sign into the pages you want ZenX to use, then start ZenX with:

```powershell
$env:ZENX_BROWSER_MODE = "user-session"
$env:ZENX_USER_BROWSER_CDP_ENDPOINT = "http://127.0.0.1:9222"
npm --workspace apps/zenx run dev
```

Modern Chromium releases may require the user to choose an explicit non-default
`--user-data-dir` when enabling `--remote-debugging-port=9222`; ZenX never starts
the browser, copies cookie databases, or attempts to unlock a profile directory.
The endpoint must be unauthenticated loopback HTTP and must identify Chrome,
Edge, or Chromium. Unavailable or incompatible endpoints remain terminal
`user-browser-cdp` diagnostics and never fall back to Playwright/Electron.
Inspection and action reuse authenticated page state in place, but only bounded
visible text and opaque target IDs reach the Agent; cookies, storage state, auth
headers, and credentials are never requested or returned. Closing a tab/session
in this mode only detaches ZenX state, and closing ZenX only disconnects CDP; the
user's tabs, browser process, storage, and profile remain intact. Settings labels
browser provider diagnostics as `user-session` or `isolated-session`.
One transient provider-local attachment-epoch boundary serializes every public
request, including tab/session/backend close, and preserves bounded create/
attach/enable/mutation/detach outcome evidence until closure is known. Inspect/
action dispatch is bound to a provider-owned CDP execution document and mutations
retain their tab lease through post-confirmation. The actual CDP send boundary
classifies known setup/protocol failures separately from dispatched outcome
uncertainty. Each attachment epoch binds the actual CDP `sessionId`, target, logical-session
owner/incarnation, and attach attempt. Lifecycle events reap only that exact
epoch; the deprecated detach-event `targetId` is used solely to correlate a
pending attach before its response and can never select a current successor.
Any unrecognized lifecycle or detach uncertainty is deduplicated, bounded, and
promoted to session taint before target/session maps are removed, so every later
normal operation fails closed while cleanup can still detach known ownership.
Active logical sessions have a fixed fail-closed admission bound and are removed
only by explicit session/backend closure. Target discovery is enabled before relying
on created/destroyed events. Logical close sends `Target.detachFromTarget` only
for ZenX-owned attachments, compensates late attachment outcomes when possible,
never reports success over remaining taint, and never sends `Target.closeTarget`.
Outcome-unknown evidence is monotonic even when compensation, target lifecycle
events, or a later detach safely close resource ownership; reconnect or logical
session reuse cannot adopt a quarantined stale attachment mapping.
Provider-created tabs start with a unique transient marker in background,
non-focused mode and are then navigated to the requested URL; the marker lets a
lost `Target.createTarget` reply be reconciled against the operation's
pre-create target snapshot without mistaking a user tab for ZenX-owned work.
CDP commands have bounded outcomes, and HTTP reconciliation plus the browser
WebSocket are restricted to the same numeric loopback authority.

The default `ZENX_BROWSER_MODE=isolated` continues to select Playwright CLI or
the bundled ephemeral Electron/CDP provider. This implementation does not claim
parity with any proprietary browser automation product.

The computer contract is platform-neutral: tools describe semantic observation,
press/value/capture operations and their interaction impact, while a platform
provider reports what it implements. The macOS provider offers targeted
AXUIElement inspect/AXPress/AXValue and window-scoped capture as
`background_safe`; these operations require an exact window title, expose at
most 32 controls, issue short-lived opaque IDs, and revalidate semantic identity
plus geometry before acting. Stale, moved, or ambiguous controls fail closed.
It also offers a reliable `foreground_required` baseline for
global click/key/scroll through a private Swift/CGEvent helper. Arbitrary
foreground text entry is omitted from this tracer bullet because an untargeted
text tool cannot prove that the focused control is non-secret. Foreground
tool names and the running card explicitly warn that the real pointer, keyboard,
or focused application can be taken over; execution waits briefly so the user
can press Stop, and cancellation terminates the helper. A background-safe action
never falls back to foreground input: missing accessibility semantics is
reported as unsupported/foreground-required.

The macOS provider requires Accessibility permission; window capture also
requires Screen Recording, and first-use helper compilation requires Apple
Command Line Tools. On Windows, ZenX selects an optional thin adapter over
Microsoft's Public Preview `winapp` CLI 0.3.1 or newer. Install it explicitly with
`winget install Microsoft.winappcli --source winget`; ZenX probes `winapp
--version` plus a read-only JSON schema probe at startup and does not expose the
provider when it is missing, too old, or schema-incompatible. Packaged builds use only an application-bundled, version-pinned, SHA-256-verified WinApp asset; missing or offline provisioning is reported explicitly. The adapter resolves an exact title to one HWND with `ui list-windows
--json`, maps bounded `ui inspect --json` results to ZenX opaque observation IDs,
uses UIA `invoke` / `set-value`, and captures with the default WGC/PrintWindow
path. It never passes `--focus` or `--capture-screen` and never silently falls
back to `click`, `send-keys`, or other global input injection. WinApp command
output, errors, duration, and artifacts are bounded; cancellation terminates the
child process, and screenshots expire after five minutes. Set-value completion is
confirmed by WinApp CLI's bounded native `wait-for --value` assertion without
projecting the value back to the Agent. WinApp CLI 0.3.1's
inspect JSON does not expose a stable password-state field; ZenX sends all supplied
text through the same ordinary UIA set-value path and leaves credential policy to
the model, project, or host. Linux is currently
unsupported for computer control.
Full arbitrary GUI automation cannot always be background-safe; an isolated
macOS/Windows session, VM, or remote host is the intended route to arbitrary
control without disturbing the user's desktop.

### Provider reuse route

This tracer bullet deliberately keeps the provider boundary compatible with
mature external implementations while retaining a runnable bundled baseline:

- macOS now discovers an optional Peekaboo 3.x CLI and pins its JSON envelope,
  permission probe, snapshot and action assumptions. It uses a fresh exact-window
  `see` before every semantic action, revalidates identity/actions, and
  invokes background `click` or `set-value` with the fresh snapshot and element
  IDs. Foreground pointer/key/scroll remains explicitly labeled. Missing,
  incompatible, or malformed Peekaboo installations produce terminal provider
  diagnostics and select the bundled Swift AX/CGEvent baseline; they never cause
  a background operation to become foreground. Install Peekaboo separately or
  set `ZENX_PEEKABOO_CLI` to an exact executable. See the upstream command and
  background validation contracts at <https://github.com/openclaw/Peekaboo/blob/main/docs/cli-command-reference.md>
  and <https://github.com/openclaw/Peekaboo/blob/main/docs/testing/background-computer-use.md>.
- Windows uses a thin optional adapter over Microsoft's MIT-licensed, Public
  Preview `winapp` CLI. UIA inspect/set-value/invoke and default WGC capture map
  to background-safe semantic tools; provider-private HWND/UIA selectors are
  translated to observation-scoped opaque ZenX target IDs/results. Startup pins
  the supported version/schema and required commands before registration.
  WinApp input-injecting verbs are deliberately not exposed by the current
  unscoped ZenX foreground contract. See
  <https://github.com/microsoft/winappCli/blob/main/docs/ui-automation.md>.
- Browser automation now prefers an optional compatible Playwright CLI (currently
  pinned to `>=0.1.0 <0.2.0`) and validates its `--json` version/list schema
  before selection. Its default headless session is reported as `isolated`, and
  every action re-snapshots and revalidates Playwright ref plus DOM
  role/name/type/visibility/action fingerprint. Missing or incompatible
  CLI installations remain explicit in provider diagnostics and use the existing
  bundled Chromium CDP ephemeral-partition provider. Packaged builds accept only
  the pinned resource manifest; development may use `@playwright/cli` or set
  `ZENX_PLAYWRIGHT_CLI`. User-session attachment remains a separate explicit CDP
  provider. See <https://playwright.dev/agent-cli/introduction>
  and <https://playwright.dev/docs/api/class-browsercontext>.
- A future `isolated` interaction mode/provider can place arbitrary control in a
  VM, cloud desktop, or remote host. OSWorld's provider separation across
  VMware/VirtualBox/Docker/cloud is a useful reference, but no VM lifecycle is
  implemented in this PR. See <https://github.com/xlang-ai/OSWorld>.

Local packages are JSON manifests placed in Electron `userData/capabilities`.
They use schema version 1, declare permissions, structured tools and optional
`skill`/`prompt` resources, and point at an executable inside the same package
directory:

```json
{
  "schemaVersion": 1,
  "id": "local-example",
  "displayName": "Local example",
  "version": "1.0.0",
  "description": "One narrow local operation",
  "provider": {
    "id": "local-example-process",
    "platforms": ["darwin", "win32"],
    "interactionModes": ["background_safe"],
    "capabilities": ["example.run"]
  },
  "permissions": [
    {
      "id": "local-example.run",
      "title": "Run example",
      "description": "Run the local example executable",
      "scope": "workspace"
    }
  ],
  "tools": [
    {
      "name": "local_example_run",
      "description": "Run the example",
      "inputSchema": { "type": "object" },
      "permissions": ["local-example.run"],
      "interactionMode": "background_safe",
      "capabilities": ["example.run"]
    }
  ],
  "resources": [],
  "runtime": { "type": "process", "command": "./provider" }
}
```

The executable receives one JSON request on stdin and returns one JSON value on
stdout. It runs without a shell, with a minimal environment and bounded
transport/output. Tool `maxOutputBytes` must be an integer from 1 KiB through
1 MiB, and the result envelope still honors that bound when provider metadata is
large. Discovery failures stay visible; ZenX does not retry them with
a durable repair workflow. There is no marketplace, signing, remote discovery,
or distribution layer.

## Verification

```sh
npm --workspace apps/zenx run check
npm run check
npm --workspace apps/zenx run smoke:capabilities
# Windows only, after installing Microsoft WinApp CLI:
npm --workspace apps/zenx run smoke:windows-computer
npm --workspace apps/zenx run smoke:windows-user-browser
npm --workspace apps/zenx run smoke:providers
```

The automated integration suite runs the timer → wakeup → App Server Turn →
streamed response → history chain, explicit cyclic/self relay and cancellation,
bounded source snapshots, two-member Room routing, strict persisted-state
validation, long timers, OAuth cleanup, link policy, and local signal routing.
The self-control tracer explicitly grants its bundled package before exercising
the child-host capability bridge, derived projects, Thread create/list/read/status,
active `start | steer | replace`, follow-up delivery, bounded redaction, canonical
command audit, and the real OpenAI subscription tool serialization boundary.
The packaged capability smoke covers a real hidden dedicated browser
open/inspect/navigate/click/type/close, including forged/stale/changed/hidden
rejection and ordinary password-field input dispatch. It also seeds a cookie and session storage, closes
the session, reopens the same ID, and verifies both are absent. It asserts those
background-safe browser operations
leave the real pointer position and foreground application unchanged. The macOS
AX helper and foreground helper compile in that packaged run, but arbitrary
third-party AX window/action smoke remains permission- and target-dependent; its
opaque latest-observation and forged/stale paths are unit-covered. The
compiled helper enforces semantic fingerprint/geometry revalidation and rejects
ambiguous matches, but that path is not claimed as a live third-party-app smoke.
On Windows, `smoke:windows-computer` launches a deterministic WinForms fixture
with a real UIA-editable control and drives the real
`WinAppCliComputerBackend` through `ComputerZenXCapabilityPackage` and the
capability registry, verifying exact PID/title→HWND resolution, bounded semantic
inspection, UIA set-value with a bounded native value assertion, a post-action
re-inspection, and WGC-default scoped capture without `--focus`
or `--capture-screen`. GitHub CI runs that path on `windows-latest` with Microsoft's
official setup action. The cross-platform fixture suite validates the same WinApp
0.3.1 JSON mapping, stale target rejection,
pre-action semantic revalidation, startup version/schema diagnostics,
timeout/cancellation, output bounds, and exact-value error redaction when a
Windows host is not available.
The provider smoke exercises the selected Playwright-or-Electron browser against
a local page through open → inspect → action → verify → close and prints bounded
provider/version/permission diagnostics. CI installs the pinned official
`@playwright/cli` and requires that provider to be selected; a local run may
exercise the Electron fallback when the CLI is absent. The smoke only probes
Peekaboo availability and permissions; it never sends desktop input.
The Windows user-browser smoke launches a real installed Chrome/Edge process
with an explicit temporary profile and CDP port, establishes authenticated state
inside that browser, attaches ZenX, lists/inspects/acts in the existing tab, and
opens a provider-created background tab while checking the foreground HWND and
both tabs' document visibility. It records the actual visible target ID before
open, after open, and after close; verifies the original target survives and the
provider-created target remains hidden; then verifies ZenX detach leaves the
browser process and tabs alive without projecting cookie material.
It does
not run foreground takeover against the user's desktop; foreground execution
and immediate pre-input cancellation are covered by provider/bridge tests. The
2026-08-09 packaged Electron smoke also covered onboarding/host
restart, Thread creation, Markdown rendering and copy affordances, the persistent
Projects/Inbox toggle, Watching, and a real timer wakeup card.

Still requiring user verification: a real OpenAI subscription OAuth grant, a
real compatible-provider key/model, and multi-person Room wording in production
work. Those flows are intentionally not claimed complete by the smoke fixture.
