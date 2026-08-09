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

## Verification

```sh
npm --workspace apps/zenx run check
npm run check
```

The automated integration suite runs the timer → wakeup → App Server Turn →
streamed response → history chain, explicit cyclic/self relay and cancellation,
bounded source snapshots, two-member Room routing, strict persisted-state
validation, long timers, OAuth cleanup, link policy, and local signal routing.
The 2026-08-09 packaged Electron smoke also covered onboarding/host
restart, Thread creation, Markdown rendering and copy affordances, the persistent
Projects/Inbox toggle, Watching, and a real timer wakeup card.

Still requiring user verification: a real OpenAI subscription OAuth grant, a
real compatible-provider key/model, and multi-person Room wording in production
work. Those flows are intentionally not claimed complete by the smoke fixture.
