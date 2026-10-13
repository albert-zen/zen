# IMZen

IMZen is a thin Python client of the Zen App Server. It composes the IM Agent
SDK v1 through its public `Gateway`, coherent `SQLiteGatewayStore`, scoped
`ConversationActions`, and frozen `CommandRegistry`. The exact reviewed SDK
revision is coordinated in `pyproject.toml`, `uv.lock`, `readiness.py`, and the
IMZenX channel-schema declaration. Changing the pin requires updating and
verifying all four, then rebuilding the generated plugin runtime.
IMZen does not implement a second
Gateway, Channel runtime, Agent backend, transcript, scheduler, or recovery
state machine.

The SDK owns Channel lifecycle, inbound admission/idempotency, typed
Conversation bindings, Zen App Server translation, Thread projection,
interactive-request routing, delivery planning, and durable bridge
state. IMZen owns only deployment configuration, product commands and
presets, approval/error presentation, generic-file manifest mapping, and the
composition root. The IMZenX plugin additionally owns PAW Room addressing and
projection checkpoints, while the Host remains the Room semantic authority.

Conversation-to-Thread bindings and delivery fencing share the same SQLite
store. Restarting keeps the selected Thread; `/new` explicitly clears it. The
store contains bridge state only, not a transcript or a second Agent runtime.

## Configuration

```sh
export IMZEN_APP_SERVER_URL=ws://127.0.0.1:4500
export IMZEN_CWD=/absolute/workspace
export IMZEN_WORKSPACE_ID=imzen-workspace
export IMZEN_GATEWAY_STATE_FILE=/absolute/private/imzen/gateway.sqlite3
export IMZEN_APP_SERVER_SHARED_FILESYSTEM_ROOT=/absolute/imzen/inbound-media
export IMZEN_PERMISSION_MODE=full-access
export IMZEN_ALLOW_UNRESTRICTED_FULL_ACCESS=true
export IMZEN_CHANNELS_CONFIG_FILE=/absolute/private/channels.json
python -m imzen
```

`IMZEN_APP_SERVER_AUTH_TOKEN_FILE` may name a private file containing the App
Server bearer token. `IMZEN_PERMISSION_MODE` accepts `full-access` (the
default) or `approval-required`. Both use Zen's supported
`danger-full-access` sandbox; they differ only in approval policy (`never` or
`on-request`). This sandbox is not isolation.

`IMZEN_GATEWAY_STATE_FILE` is required. It holds SDK-owned bridge state such as
durable idempotency claims, including `side_effect_started`; this prevents a
native redelivery after process restart from reauthorizing an input whose App
Server outcome is unknown. `IMZEN_WORKSPACE_ID` is a stable deployment identity
(default `imzen-workspace`), not a native runtime Project. The SDK records its
canonical workspace-root fingerprint and refuses to silently reuse that identity
for another root. Keep the identity and original state file when restarting.

`IMZEN_APP_SERVER_SHARED_FILESYSTEM_ROOT` declares the trusted local image root.
The SDK reads bounded, no-follow image bytes beneath it, validates declared sizes,
and sends a data URI to ZAS. IMZen never falls back to a path-only image payload.
Legacy typed image inputs may omit `size_bytes`: IMZen derives bounded size
metadata only beneath that same selected root and retains the original LocalPath
for the SDK's no-follow read. Explicit invalid sizes are not repaired, symlinks
are not converted into trusted canonical paths, and no broader root is inferred.
The built-in IM channels already supply the actual size from their media staging.
Supported image types are PNG, JPEG, GIF, and WebP, at most 20 MiB each, 16 images,
and 32 MiB per input. Standalone IMZen requires an explicit trusted root even for
loopback servers; a local spool or loopback address alone does not grant trust.
The server need not open a bridge-local image path. Generic-file manifests still
refer to staged local paths and require the deployment's shared filesystem.

Only IMZenX, whose Host launches both local processes, can infer a root when
this setting is absent. It selects an enabled channel's explicitly configured
`media_dir` only if that directory contains all other explicitly configured
media directories, creating the selected root when missing. It never expands
the boundary to an undeclared common ancestor. Disjoint media directories leave
images unattested; use an explicit shared root if the deployment intends to
trust that broader directory and all files beneath it. SDK-default media
directories do not contribute a root. An explicit shared root always wins,
including when it excludes a configured channel's media directory.

If an enabled channel has neither `allowed_user_ids` nor
`allowed_conversation_ids`, Full Access requires the explicit deployment
opt-in `IMZEN_ALLOW_UNRESTRICTED_FULL_ACCESS=true`. This host configuration
never enters Zen Core or a Thread.

The channel config is a JSON object passed to the SDK channel factory:

```json
{
  "qq": {
    "enabled": true,
    "credentials_file": "/absolute/private/imzen/qq.json",
    "markdown_enabled": true,
    "allowed_user_ids": ["trusted-user-id"]
  }
}
```

The QQ credential file contains only `appid` and `appsecret`, is owned by the
current user, and must be mode `600` on POSIX. Supported top-level channels are
`qq`, `telegram`, `feishu`, and `weixin`; Feishu requires the `feishu` extra.
Each deployment owns its config and credentials. Do not run two clients with
the same bot credentials.

## Commands

- `/new` clears only this Conversation's binding; the next ordinary message
  creates a Zen Thread.
- `/threads [query]` and `/pick <number|id|query>` list/select authoritative
  App Server Threads. Selection changes the Gateway binding and observation;
  it intentionally does not activate a native desktop/TUI Thread.
- `/status` reads the selected Thread from Zen.
- `/catchup [messages]` shows recent commentary from the latest Turn.
- `/history [turns] [--page N]` reads authoritative recent Turn history.
- `/delete` is explicit but unsupported because Zen's App Server adapter does
  not claim native Thread deletion.
- `/model` lists the host ModelCatalog; `/model <name>` changes the selected
  Thread for later Turns.
- `/permission full-access|approval-required` changes the preset and clears
  the current binding because the effective Thread policy is immutable
  history.
- `/approve`, `/deny`, and `/cancel` use the stable SDK request reference shown
  in the approval message. Native transport request IDs are not exposed as
  routing authority. `/respond` remains the SDK's general typed command.

Downloaded generic files are represented in the Zen input as an explicit
`[Attachments]` text manifest with staged local paths. Images remain typed
image input containing verified bytes. QQ exposes text, file, and image as separate inbound message
shapes; IMZen accepts attachment-only file and image messages directly and
does not synthesize or join a caption from adjacent text messages. Markdown
Agent output is delivered unchanged.

## Upgrade from SDK v0

Startup checks the selected state file before opening it with the v1 store.
For the supported v0 schema, it preserves a private byte-for-byte backup,
verifies every legacy Thread's exact native ID and workspace root with ZAS,
migrates a staging copy, validates its bindings/routes/idempotency through a
fenced v1 store session, then atomically replaces the original. A missing or
ambiguous workspace ancestor is never inferred from the configured ID alone.

Stop the old consumer cleanly before upgrading. Legacy WAL/journal sidecars,
unrecognized schemas, conflicting scope, unsafe historical delivery identities,
or failed native validation block migration with an actionable error. Do not
delete the database or sidecars to get past a blocked migration. Preserve the
original and backup for a schema-specific or journal-aware migration. Current
v1 WAL recovery and runtime lease fencing remain SDK-owned.

Common navigation/history/request commands use the SDK registry. IMZen owns
`/new`, `/permission`, `/model`, approval aliases, and bounded displayed Thread
selection; `/pick <number>` requires this conversation's displayed list and does
not re-list behind the user's number. An oversized response asks for a narrower
query and keeps the last displayed numbers. Non-numeric ID/title queries work
without a current numbered view, but do not silently replace that view. ZAS remains Thread/Turn truth. Permission
presets are registered immutable creation profiles passed through the SDK's
fenced create-and-bind workflow, never an unfenced direct Thread creation.

## Active-Turn input

The pinned Zen adapter starts a new Turn when the Thread is idle. During a
steady active Turn previously started through IM, further input steers that
same native Turn with an exact expected-Turn fence, retaining the original IM
reply correlation. Images still require declared size and trusted rooted bytes;
steering does not broaden filesystem access or depend on a local-image epoch.
The SDK's explicit `steer_active_turn=False` constructor opt-out remains available.

This does not accept every mid-turn message. An active Turn started outside IM
has no IM reply correlation and is rejected before native input dispatch.
Concurrent admission can still race with initial correlation or Turn completion;
a native ended-Turn rejection remains a failure with no fallback start.
Unknown transport outcomes are reported without automatic mutation replay.
There is no new queue, retry policy, permission setting or Turn authority.

## SDK extension boundaries

IMZen configures I1 inbound content transformation, I2 classified failure
presentation, and request presentation. IMZenX uses O1 to suppress private
Thread projections while a formal PAW Room is selected. Explicit, bounded SDK
startup preparations clear obsolete PAW/Thread bindings before applications,
channels, projection recovery, or request delivery can start. A failed
preparation prevents startup; it never opens a temporary cross-route window.
Disabled channels retain their PAW route/checkpoint but are excluded from startup
preparation and polling until re-enabled.

`/model` is a Zen-specific native operation. Its effectful command is covered by
inbound fencing; ambiguous transport failures are reported as “may already have
applied,” and an explicit same-value retry is safe. There is no local outbox or
second creation/recovery authority.

## Verification

```sh
uv sync --all-extras
.venv/bin/python -m pytest -q
.venv/bin/ruff check src tests
.venv/bin/ruff format --check src tests
```

## Manual QQ smoke test

1. Start a Zen App Server and IMZen with a private QQ credential file and a
   narrow allowlist.
2. Send an ordinary message; verify one new Thread/Turn and one Markdown reply
   referencing the QQ message.
3. Redeliver the same native message ID; verify no second Turn.
4. Run `/threads`, `/pick`, `/status`, `/catchup`, `/history`, `/model`, and
   `/permission approval-required`.
5. Trigger a command approval and exercise `/approve`, `/deny`, or `/cancel`
   with the shown stable request reference.
6. Send one small generic file as a file-only QQ message; verify exactly one
   Turn receives its `[Attachments]` manifest.
7. Send one image as an image-only QQ message; verify exactly one Turn receives
   native image bytes without synthetic text or a path-only fallback.
8. Stop the App Server or force a Turn failure; verify an explicit classified
   IM error and no self-repair queue.

This smoke test requires real QQ credentials and is intentionally not automated
or claimed as completed by the repository test suite.

## ZenX plugin reuse

IMZenX packages this same Python source and pinned dependency inside its
first-party npm tarball. `create_gateway(..., persistent_subscriptions=True)`
uses the same SDK SQLite store and public startup preparation boundary. `/threads` followed by
`/pick <number>` selects a Thread and receives its replies; `/new` clears selection.
Legacy `/subscribe` and `/unsubscribe` remain aliases. Both standalone and plugin
composition preserve selected Threads across restart.
The product App Server client drains at most 1,000 native Thread summaries for
SDK-requested updated-time sorting and search. It uses plain `thread/resume`
for snapshot-plus-live socket observation because ZAS `thread/read` alone does
not subscribe. This does not activate or change the desktop's selected Thread;
SDK routes remain the authority for IM recipients. No core ZAS sorting or
Thread semantics are added for SDK compatibility.

### PAW Rooms in IMZenX

The plugin child also composes a PAW controller over the same SDK Gateway:

- `/paws` lists PAWs in the Host's configured workspace. Each conversation's
  numbered list remains stable until refreshed.
- `/paw <number|id>` selects its authoritative Room. Existing Room history is
  the selection baseline; new explicit agent Room posts arrive in this IM
  conversation. `/paw` reports the current route and any paused-route error.
- Ordinary text in PAW mode posts a human message to that Room through the
  Host's existing Room admission service. It never starts an SDK Thread Turn.
  Attachments are rejected with a clear reply, without posting partial text.
- `/new`, `/pick`, and their legacy aliases return to normal Thread mode.
  A failed `/pick` keeps the current PAW selection.

PAW selection clears the SDK Thread binding before saving its Room address.
The product's SDK outbound-presentation seam suppresses Thread projections
while that Room is selected, including private working-Thread outputs.
Formal Room messages are the only PAW outbound source; human and system posts
are checkpointed without echoing. A route change fences an outstanding Room
read before delivery. Canonical quotes, reactions and native IM receipts are
not translated in this first text-only adapter.

The child requests `list`, `read` and `post` on its existing stdin/stdout pipe.
The Host resolves all operations in its configured workspace; no Room runtime
or transcript is copied to Python. Lines and responses are bounded to 1 MiB,
with at most 16 outstanding requests and a 30-second response timeout. The
child reads bound Rooms every two seconds and exits when the parent closes
stdin, cancelling the poll and stopping the SDK Gateway. A bounded daemon
reader with one-slot backpressure handles inherited stdin on all supported
platforms without requiring a Windows overlapped pipe handle. Protocol JSON
uses ASCII escapes so text round-trips independently of the process locale.

`<gateway-state-basename>.paw.sqlite3` stores only external-conversation Room
addresses, operation epochs, inbound admission facts and last canonical Room
message IDs. SDK delivery submissions remain in the configured gateway SQLite
file. Stable external-message IDs and Room operation epochs derive inbound
client IDs; unknown admission is reported and never automatically reposted.
Stable Room-message IDs use public SDK `deliver_proactively`, preserving
accepted and unknown delivery outcomes across restart without a local outbox.

The Host's bounded last-50 Room read must contain the saved checkpoint. Missing
history, a changed Room epoch, or a failed/unknown delivery pauses only that
route and reports the reason in `/paw`, while other PAWs and Thread mode remain
available. The adapter attempts one SDK-idempotent pause notice; if the channel
cannot deliver it, `/paw` still exposes the failure. Reselecting with `/paw`
explicitly chooses a fresh baseline. There is no durable recovery daemon or
automatic retry of an ambiguous mutation.
