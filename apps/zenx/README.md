# ZenX

ZenX is Zen's in-development Electron client. It hosts the same App Server used
by the CLI and keeps desktop-only configuration and orchestration outside Zen
Core.

## Run

```sh
npm --workspace apps/zenx run dev
```

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

Agent-callable `trigger.create` / `trigger.cancel` tools and a production external
signal ingress are not part of this slice. They remain follow-up ZenX-host
features; neither should be added to Zen Core or the Codex-compatible protocol.

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
Inspect/action dispatch is bound to a provider-owned CDP execution document and
mutations retain their tab lease through post-confirmation. Logical close sends
`Target.detachFromTarget` only for ZenX-owned attachments and never sends
`Target.closeTarget` for user tabs.

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
provider when it is missing, too old, or schema-incompatible. The adapter resolves an exact title to one HWND with `ui list-windows
--json`, maps bounded `ui inspect --json` results to ZenX opaque observation IDs,
uses UIA `invoke` / `set-value`, and captures with the default WGC/PrintWindow
path. It never passes `--focus` or `--capture-screen` and never silently falls
back to `click`, `send-keys`, or other global input injection. WinApp command
output, errors, duration, and artifacts are bounded; cancellation terminates the
child process, and screenshots expire after five minutes. Set-value completion is
confirmed by WinApp CLI's bounded native `wait-for --value` assertion without
projecting the value back to the Agent. WinApp CLI 0.3.1's
inspect JSON does not expose a stable password-state field, so ZenX conservatively
rejects controls whose control type, name, automation ID, or class name looks
secret-bearing; regardless of that heuristic, all `computer_set_value` calls are
explicitly non-secret-only because their text is journaled. Linux is currently
unsupported for computer control.
Full arbitrary GUI automation cannot always be background-safe; an isolated
macOS/Windows session, VM, or remote host is the intended route to arbitrary
control without disturbing the user's desktop.

### Provider reuse route

This tracer bullet deliberately keeps the provider boundary compatible with
mature external implementations while retaining a runnable bundled baseline:

- macOS now discovers an optional Peekaboo 3.x CLI and pins its JSON envelope,
  permission probe, snapshot and action assumptions. It uses a fresh exact-window
  `see` before every semantic action, revalidates identity/security/actions, and
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
  role/name/type/security/visibility/action fingerprint. Missing or incompatible
  CLI installations remain explicit in provider diagnostics and use the existing
  bundled Chromium CDP ephemeral-partition provider. Install `@playwright/cli`
  plus its browser separately or set `ZENX_PLAYWRIGHT_CLI`; user-session attachment
  remains a separate explicit CDP provider. See <https://playwright.dev/agent-cli/introduction>
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
opaque latest-observation and forged/stale/secure paths are unit-covered. The
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
0.3.1 JSON mapping, conservative secure-control heuristic, stale target rejection,
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
then verifies ZenX detach leaves the browser process and tabs alive without
projecting cookie material.
It does
not run foreground takeover against the user's desktop; foreground execution
and immediate pre-input cancellation are covered by provider/bridge tests. The
2026-08-09 packaged Electron smoke also covered onboarding/host
restart, Thread creation, Markdown rendering and copy affordances, the persistent
Projects/Inbox toggle, Watching, and a real timer wakeup card.

Still requiring user verification: a real OpenAI subscription OAuth grant, a
real compatible-provider key/model, and multi-person Room wording in production
work. Those flows are intentionally not claimed complete by the smoke fixture.
