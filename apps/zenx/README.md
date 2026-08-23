# ZenX

ZenX is Zen's in-development Electron product. Its main process hosts the same
App Server used by the CLI and keeps desktop-only configuration and
orchestration outside Zen Core.

## UI/UX decisions

Current UI/UX product rules are maintained only in [docs/ui-ux.md](docs/ui-ux.md).

## Runtime boundaries

Projects are ZenX host-profile workspace entries grouped with ZAS native Thread
`cwd` by canonical filesystem identity; symlink/junction aliases share one
Project while the configured user-selected path remains its display path. The
projection resolves the nearest existing ancestor asynchronously and falls back
to the lexical absolute path when realpath is unavailable, so missing or denied
paths remain usable. It publishes configuration refreshes latest-wins and
re-canonicalizes immutable per-operation snapshots, so filesystem identity may
recover or change without becoming a permanently cached Project key. Projects
are not Core runtime objects. Removing an entry only changes the host profile
and never deletes the directory, its files, or Thread journals.

Thread list product data is defined by ZAS's native `ThreadSummary` /
`CurrentMetadata` read model. Electron main queries it through the existing
host-local process boundary and preload exposes a typed IPC method. Codex Thread
DTOs remain compatibility-only protocol types; they do not define ZenX's product
model. The renderer and Agent self-control consume the same main-process Project
projection instance.

## Plugin platform contract and current status

The checked-in implementation now has Plugin Package v2 descriptors and a
Host-owned Catalog for the `installed` / `enabled` / `uninstalled` lifecycle.
Bundled Triggers/Rooms and local process packages use the same lifecycle API;
disable and uninstall revoke their current runtime/tool/sidebar/page
registration, bundled packages can be reinstalled from the app-supplied
package, and uninstall preserves namespaced plugin data unless deletion is
requested separately. Existing capability grants are migrated and retained as
compatibility data. Zen Core now has the provider-neutral dynamic Tool Environment
for builtin, plugin, and external provider identities, including Host policy,
prepared-call stability, execution, and cancellation. ZenX injects builtin
`shell` and its startup capability snapshot as distinct providers; registry
changes still require the existing Host refresh instead of live provider updates.
The ZP3 Host seam now provides one Plugin Runtime Supervisor and ABI for trusted
bundled modules, persistent child processes, and HTTP services. It registers each
enabled plugin as its own Tool Environment provider, routes exact namespaced tools,
propagates abort/close, drains prepared and executing admitted calls during revocation,
and performs no retry or restart. Catalog install/enable stages runtime readiness without
publishing tools until persistence commits; disable/uninstall closes new admission first
and restores the enabled provider on persistence failure. Disabled reinstall stays disabled.
The desktop composition connects that authority to the hosted AppServer: the
main-process CapabilityService owns the Catalog, Registry, Supervisor, and plugin
Tool Environment, while the child host combines its current snapshot with builtin
`shell`, still-compatible external capabilities, and one persistent `zenx_plugin`
provider. Its request-time projection discloses only the selected plugin after
successful ordinary `read` call/result history, rebuilding the same set from the
journal after restart and intersecting it with current availability. Disclosed
calls cross the existing private capability bridge and execute through the main
Supervisor's stable plugin provider. Human product calls may still route directly
through the Supervisor without creating an AppServer Turn.

Plugin Host SDK v1 is the public `query / actions / ui / storage` contract injected
into each runtime. `query.projects.list` consumes the existing main-process Project
projection. Plugin storage is a 1 MiB bounded JSON document under the plugin-id
namespace with versions 1..1000; package/runtime migrations must advance one version
at a time and run only when the durable version is behind. Writes and migrations use
serialized atomic replacement, so failure leaves the prior state visible. Disabling
or uninstalling a plugin does not remove that data. Bundled modules receive the SDK
object directly; JSONL process and HTTP adapters expose the same operations through
bounded SDK request/result envelopes and never expose internal stores. Ordinary SDK
queries, storage, and UI commands do not create Turns. Only the explicit
`actions.threads.startTurn` operation reaches the existing AppServer port and returns
its canonical Items. The Generic UI Host now projects the `ui` group into versioned
trusted or isolated renderer bundles and owned surfaces. Both receive the same logical
theme/context, opaque handle, navigation, and command API; isolated HTML runs in a
sandboxed iframe without same-origin authority and talks only through validated messages.
Sidebar contributions use the bounded product icon keys `clock`, `layers`, `plug`,
`settings`, `terminal`, `trigger`, or `users`; package validation rejects any other key.

Settings now exposes the complete local/bundled package lifecycle through typed
main/preload IPC: choose a local v2 JSON manifest, install or update it, enable or
disable it, uninstall/reinstall it, and explicitly delete only its namespaced data
after the runtime is disabled or uninstalled.
Update validates and stages the replacement runtime/UI/storage migration before the
catalog changes; a failed stage, migration, catalog save, or publish restores the old
version and its storage. `ToolResultItem` keeps optional namespaced, JSON-compatible
structured content alongside unchanged text output and exit code. The Tool Environment
validates ownership and a 1 MiB bound before append. The current enabled v2 manifest
selects a trusted or isolated Generic UI Host result surface; missing, disabled,
uninstalled, or incompatible renderers use deterministic JSON/Text fallback without
rewriting history. The app-owned
Host already publishes its one ZAS authority through a private authenticated
loopback descriptor that survives window closure.

The target contract is:

- Zen's provider-neutral `AgentRuntime` owns the agent loop and the canonical
  `tool_call` / `tool_result` lifecycle. Its Tool Environment combines builtin
  providers such as `shell`, plugin providers, and external providers. Zen
  resolves names, applies Host policy, routes, cancels, and writes results;
  plugins or external services own their domain execution.
- A Plugin Runtime may be a bundled module, child process, local service, or
  remote service. Plugin Host and ZAS/AppServer are sibling services owned by
  ZenX Host; neither plugin UI nor runtime owns Agent, Thread, Turn, or
  transcript semantics.
- The model initially sees builtin tools plus one stable `zenx_plugin` tool.
  `discover` returns plugin id, name, short description, and status. `read`
  returns the main document and tool index. Later model samples expose the
  selected plugin's ordinary namespaced structured tool schemas.
- Discovery uses ordinary existing tool calls/results. No plugin catalog or
  tool-disclosure canonical Item is added. Existing model text, reasoning,
  tool/title trace remains byte-for-byte unchanged; capability changes affect
  only future projection or future call results.
- Only a well-formed `read` call followed by an exit-code-zero result envelope
  for the same plugin id discloses schemas. Discover, malformed/failed calls,
  and mismatched results do not. Disable or uninstall removes the plugin from
  new discovery and later schema projections without editing journal history.
- The target tool policy is only default `full_access` and optional
  `ask_unknown`. The latter keeps Host-owned `approvedTools` / `deniedTools` by
  stable tool name and asks once for an unknown tool. The current capability
  grants are implementation facts, not the target permission model; there is no
  risk scoring, scope graph, or argument-level rules engine.
- Plugin lifecycle is `installed` / `enabled` / `uninstalled`. Bundled plugins
  can also be uninstalled and later reinstalled. Uninstall removes runtime, UI,
  and tool registrations but retains plugin data by default; deleting data is a
  separate explicit action.
- Generic UI Host supports sidebar, pages/subroutes, settings, panel,
  commands/menu, and result renderers. First-party and third-party plugins use
  the same logical UI SDK, while third-party code runs isolated. Human plugin UI
  actions do not create a Turn; only an explicit **Run Agent** action calls
  AppServer.
- Result renderers consume optional structured content on the existing
  `ToolResultItem`, not a new Item type. Missing or disabled renderers fall back
  to text/JSON without changing historical trace. Standalone Skills are
  deferred; a plugin's main document is its primary model instruction.
- ZenX Host exposes its single ZAS through a stable authenticated loopback
  endpoint that other apps can connect to. Closing every window keeps the Host
  and active Turns running; activation recreates the UI, while explicit Quit
  revokes discovery and stops the endpoint. This does not create an OS daemon.

Marketplace, signing, dependency solving, same-Turn parallel tool execution,
and unrelated Provider/image/attachment/compaction refactors are outside this
phase.

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

## External App Server clients

While ZenX is running, its app-owned Host publishes
`<Electron userData>/runtime/app-server.json`. The private version-1 descriptor
contains the loopback WebSocket URL and the absolute path of a separate private
bearer-token file; it never embeds the token. A client reads the descriptor,
loads that bearer file, and performs the fixed Codex App Server 0.146.0
`initialize` / `initialized` handshake over the existing WebSocket transport.
ZenX's renderer uses the same ZAS instance, so either side can create, resume,
read, or continue the same Thread.

The runtime directory, descriptor, and token are owner-private on POSIX;
Windows uses the current user's Electron profile boundary. A second ZenX
process defers to the process holding Electron's single-instance lock and cannot
publish a competing authority. Closing the last window leaves the descriptor,
connection, Host, and active Turn intact. Explicit Quit first revokes the
descriptor, then stops the one child Host, closes clients clearly, and removes
the token. These files are Host connection configuration: they are not renderer
settings, protocol payloads, logs, model trace, or canonical journal data.

The Windows packaged Project acceptance (`smoke:windows-projects`) launches the
real packaged ZenX shell and exercises the Project workspace lifecycle through a
main-process acceptance hook that executes only when its explicit isolated
config environment parameter is present. The main process consumes and removes
that parameter before starting any child host. The hook uses the real renderer
and IPC without opening a debug port and confirms that workspace removal
preserves Project marker files.

## Host configuration

ZenX host profile v3 stores multiple stable Provider profiles. Each profile owns
its connection fields and structured model catalog; every model records display
metadata, hidden state, source, reasoning efforts/default, input modalities, and
context window. Capability `null` means Unknown while an empty array means known
unsupported, so an ID-only discovery result is never promoted into guessed
reasoning, image, or context-window support. Default and title models remain
explicit `(providerProfileId, modelId)` references. The hosted App Server
registers every configured profile, so profiles may expose the same model ID
without sharing metadata, routing, or credentials. Applying relevant
host-profile changes restarts the local host; existing Thread model settings
remain authoritative in ZAS. Removing a profile never scans or rewrites Threads:
an old Thread remains readable, fails clearly when that profile is unavailable,
and runs again only after an explicit switch to an available profile.

Built-in model metadata is versioned separately from the profile and contains
only repository-confirmed facts. The five OpenAI subscription input-modality
entries are curated from the versioned models.dev OpenAI catalog; this is a
verified external catalog source, not a claim that `GET /models` returned those
facts. The entries were checked on 2026-08-23 against the models.dev `dev`
branch files for `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`,
and `gpt-5.4` under <https://github.com/anomalyco/models.dev/tree/dev/models/openai>.
Manual entries and per-model overrides are stored in the profile.
OpenAI-compatible profiles can optionally issue
credential-scoped `GET <baseUrl>/models` discovery through that profile's system
proxy transport. Discovery reads IDs plus only explicitly parseable modality
fields returned by that Provider, then performs exact-ID enrichment from the
built-in verified catalog. It never infers capabilities from model names;
unmatched or bare-ID results remain Unknown. Discovery does not persist
credentials or modify the configured/manual catalog on success or failure. A discovered model with no
known reasoning capability is non-runnable even when a Thread supplies an
explicit effort; it requires a manual catalog capability override before it can
become the canonical selection. The fixed Codex 0.146.0 `model/list` omits such
non-default entries while continuing to expose valid configured models, and a
completed manual override makes the entry visible. Default and title models
must have runnable, wire-representable reasoning and text-input metadata.

The OpenAI subscription preset exposes the five models confirmed by the current
host: `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, and `gpt-5.4`.
Sol and Terra expose `low / medium / high / xhigh / max / ultra`; Luna exposes
those efforts through `max`; 5.5 and 5.4 expose `low / medium / high / xhigh`.
All default to `medium`. All five have verified text and image input in the
versioned external catalog; Zen does not yet project their PDF input. Context
windows remain Unknown in Zen's curated preset.

Host profiles live under Electron `userData` without credentials. Compatible
provider API keys are encrypted with Electron `safeStorage` and keyed by stable
Provider profile ID; deleting one profile clears only its key. Subscription OAuth
uses a profile-scoped independent mode-0600 host file (the migrated
`openai-codex` profile retains the existing path). Neither credential form is
written to the Host profile, renderer settings, App Server protocol
configuration, or shell environment. Provider, model, and tool output is trace:
ZenX does not scan or rewrite it merely because its bytes match a credential,
and normal Runtime rules may persist that content in Thread journals. Existing
v1 single-provider profiles and v2 string-catalog profiles migrate
deterministically on first start and are immediately persisted as v3 without
changing the selected `(providerProfileId, modelId)` or rewriting Threads. The
migrated ID preserves the old runtime identity (`fake`, `openai-codex`, or the
configured compatible-provider name); legacy unknown model IDs retain the prior
`medium`/text runtime contract so existing configurations remain runnable.

Settings → Models & providers exposes every profile as an independently editable
row. Global Default and Title selectors show both Provider display name and model
ID. Custom catalogs use repeatable model rows; an existing compatible profile can
fetch `/models` IDs and explicit modality metadata with exact-ID verified-catalog
enrichment. Unknown capabilities remain visibly Unknown, and each row can store an
explicit manual reasoning/input/context override. A saved Unknown model offers one
user-triggered tiny image probe with a cost warning; only success or an explicit
image-type rejection is persisted, while auth, quota, rate-limit, network,
missing-model, and ambiguous failures remain inconclusive. Saved keys are represented
only by presence—blank credential input keeps the existing key. Deleting a
profile that owns either global model requires the corresponding replacement(s)
and sends them with the deletion in one host mutation; Settings never changes
historical Thread selections. ZenX exposes at most one OpenAI subscription profile
in this UI; Account login/logout follows that profile's stable ID, and deleting it
clears its profile-scoped OAuth credential without reviving historical Threads.

Add provider also offers stable OpenAI-compatible connection presets for
SiliconFlow（硅基流动）, DashScope, DeepSeek, Kimi, and Zhipu（智谱）. Their
host-owned profiles still use the same adapter, credential vault, manual catalog
editor, and `GET /models` discovery path as a custom Provider; the presets add no
Provider-specific protocol or inferred model capabilities.

## Triggers and Rooms

ZenX can register one-shot or recurring timers, `turn_completed` watches, Room
mentions, and named signal conditions. A hit persists an auditable occurrence
with a stable client message ID, then starts a normal App Server Turn. Failures
remain visible and are never silently retried.

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

## Current capability skeleton

ZenX owns a capability registry outside Zen Core. It records bundled or local
package provider/platform metadata, requested permission scopes, tool
capabilities and interaction mode, instruction resources, and a recent in-memory
audit projection. Granting or revoking a package restarts the local host so the
Agent sees exactly the currently authorized tool definitions.
Capability grants, per-call approval, and the execution sandbox remain separate
concepts. A host may impose a background-only execution policy without treating
that restriction as a missing grant.

Capability packages supply the installed-plugin lifecycle and UI projection. A v2
manifest may declare controlled sidebar, page/subroute, settings, panel,
command/menu, versioned bundle and surface contributions; the main-process registry
projects enabled contributions through the typed `window.zenx.plugins` preload
API and never gives a package DOM or router access. Enablement is persisted next
to grants in the same atomic capability configuration document, but remains a
separate field and meaning: disabling removes UI contributions and host tools,
then aborts and settles already accepted package executions before the
serialized App Server capability restart completes. Grant, revoke, and
enablement mutations share one ordered configuration boundary, so concurrent UI
requests cannot lose the last operation. Permission grants are retained and do
not imply enablement. Tool-only packages are valid and simply contribute no UI.

Triggers (`zenx-triggers`) and Rooms (`zenx-rooms`) are currently separate
bundled capability packages over the existing Trigger/Room service. Each exposes
only its own controlled product contributions. Their migration to complete
Plugin Packages is future work. Disabling either package removes only its own
projection and tools; the Trigger/Room data model and canonical Turn delivery
remain unchanged.

### Bundled self-control provider

The `zenx-self-control` package is a bundled, cross-platform,
`background_safe` capability. It is hidden from the Agent until its
workspace-read and local-device-control permissions are granted; grant/revoke
uses the same host restart behavior as every other package. Its
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
user's tabs, browser process, storage, and profile remain intact. Host
diagnostics identify the browser provider as `user-session` or
`isolated-session`.
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
operations explicitly surface that the real pointer, keyboard, or focused
application can be taken over; execution remains cancellable and cancellation
terminates the helper. A background-safe action never falls back to foreground
input: missing accessibility semantics is reported as
unsupported/foreground-required.

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

Local Plugin Package v2 manifests can be selected from Settings. ZenX records the
absolute trusted manifest location so the supplied package can be mounted again on
restart; manifests already placed in Electron `userData/capabilities` remain supported.
The current process runtime seam requires the entry to stay inside that package
directory. Schema v1 capability manifests remain
readable for migration, but new packages use v2 and declare stable identity,
compatibility, runtime, main document, tools, and controlled UI descriptors:

Progressive discovery requires a stable id, non-empty name, short description,
main document, and each ordinary namespaced tool's name, description, and input
schema. Schema v1 remains readable through the existing capability compatibility
path, but it is not presented as a discoverable v2 plugin because it has no honest
main-document contract.

```json
{
  "schemaVersion": 2,
  "id": "local-example",
  "name": "Local example",
  "version": "1.0.0",
  "description": "One narrow local operation",
  "compatibility": { "zenx": ">=0.1.0 <0.2.0" },
  "mainDocument": "Use local_example_run for the narrow local operation.",
  "storageVersion": 1,
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
  "ui": {
    "bundles": [
      {
        "id": "main",
        "apiVersion": 1,
        "kind": "isolated",
        "entry": "<main id='app'>Local example</main>"
      }
    ],
    "surfaces": [
      {
        "id": "home",
        "bundleId": "main",
        "exportName": "home"
      }
    ]
  },
  "contributions": {
    "pages": [
      {
        "id": "home",
        "title": "Local example",
        "route": "/plugins/local-example/home",
        "surfaceId": "home"
      }
    ],
    "sidebar": [
      {
        "id": "home",
        "label": "Local example",
        "icon": "plug",
        "pageId": "home"
      }
    ]
  },
  "runtime": { "type": "process", "entry": "./provider" }
}
```

When a later local manifest raises `storageVersion`, ZenX invokes the same trusted
process once per required step with the internal operation
`zenx_plugin_storage_migrate` and arguments `{ fromVersion, toVersion, value }`.
The process returns the migrated JSON value. Every step must advance exactly one
version; a missing/failed/invalid step leaves the prior package and storage active.

The legacy local-capability discovery seam currently launches its executable once
per request, without a shell, using one bounded JSON stdin/stdout value. The ZP3
Plugin Runtime process adapter instead keeps one child attached through a bounded
version-1 JSONL protocol: the child first reports `ready` with exact plugin/package
identity, then handles `invoke`, `cancel`, and `close` messages and returns matching
`result` or `error` messages. Malformed, oversized, timed-out, or crashed transports
fail all affected calls explicitly and are never retried or restarted. The HTTP
adapter sends the same identity/invocation envelope as one abortable POST and
validates a bounded matching result envelope; close detaches and aborts outstanding
requests without asking ZenX to own the remote service lifecycle. Tool
`maxOutputBytes` remains an integer from 1 KiB through 1 MiB on the capability
projection. Discovery failures stay visible; there is no durable repair workflow,
marketplace, signing, remote discovery, or distribution layer.

## Verification

```sh
npm --workspace apps/zenx run check
npm run check
npm --workspace apps/zenx run smoke:capabilities
npm --workspace apps/zenx run smoke:external-zas # packaged macOS app + external client
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
2026-08-09 packaged Electron smoke also covered onboarding/host restart, Thread
creation, Markdown rendering and copy affordances, desktop navigation, Watching,
and a real timer wakeup card.

Still requiring user verification: a real OpenAI subscription OAuth grant, a
real compatible-provider key/model, and multi-person Room wording in production
work. Those flows are intentionally not claimed complete by the smoke fixture.
