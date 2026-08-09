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
or local package, its requested permission scopes, enabled tools, instruction
resources, and recent in-memory audit projection. Granting or revoking a package
restarts the local host so the Agent sees exactly the currently authorized tool
definitions. Capability grants are separate from per-call approval and from the
execution sandbox.

The bundled browser provider opens visible, ephemeral Electron sessions. Its
tools list/open/navigate/inspect/click/type one explicit `sessionId` and `tabId`;
inspection returns bounded visible text and targets, never cookies, storage,
headers, or unrelated tabs. The bundled computer provider currently supports
macOS. It inspects the frontmost app/window and display geometry, writes an
explicit screenshot to a mode-0600 five-minute temp artifact instead of the
Thread journal, and uses an ephemeral Swift/CoreGraphics helper for bounded
click/type/key/scroll actions. Computer input requires macOS Accessibility;
screenshots require Screen Recording; the helper requires Apple Command Line
Tools on first input use.

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
      "permissions": ["local-example.run"]
    }
  ],
  "resources": [],
  "runtime": { "type": "process", "command": "./provider" }
}
```

The executable receives one JSON request on stdin and returns one JSON value on
stdout. It runs without a shell, with a minimal environment and bounded
transport/output. Discovery failures stay visible; ZenX does not retry them with
a durable repair workflow. There is no marketplace, signing, remote discovery,
or distribution layer.

## Verification

```sh
npm --workspace apps/zenx run check
npm run check
npm --workspace apps/zenx run smoke:capabilities
```

The automated integration suite runs the timer → wakeup → App Server Turn →
streamed response → history chain, explicit cyclic/self relay and cancellation,
bounded source snapshots, two-member Room routing, strict persisted-state
validation, long timers, OAuth cleanup, link policy, and local signal routing.
The packaged capability smoke covers real browser
open/inspect/navigate/click/type and real macOS computer inspect/screenshot; set
`ZENX_SMOKE_COMPUTER_INPUT=1` to target the smoke-owned browser input with real
computer click/type. The 2026-08-09 packaged Electron smoke also covered onboarding/host
restart, Thread creation, Markdown rendering and copy affordances, the persistent
Projects/Inbox toggle, Watching, and a real timer wakeup card.

Still requiring user verification: a real OpenAI subscription OAuth grant, a
real compatible-provider key/model, and multi-person Room wording in production
work. Those flows are intentionally not claimed complete by the smoke fixture.
