# IMZen

IMZen is a thin Python client of the Zen App Server. It composes the IM Agent
SDK at the complete ADR 0015 rollout commit merged to SDK `main`,
`57f255fb1f40a095aeabb5a6967380ba057494a3`; it does not implement a second
Gateway, Channel runtime, Agent backend, transcript, scheduler, or recovery
state machine.

The SDK owns Channel lifecycle, inbound admission/idempotency, typed
Conversation bindings, Zen App Server translation, Thread projection,
interactive-request routing, delivery planning, and the in-memory bridge
repositories. IMZen owns only deployment configuration, product commands and
presets, approval/error presentation, generic-file manifest mapping, and the
composition root.

Conversation-to-Thread bindings remain in memory. Restarting IMZen therefore
starts a new Zen Thread on the next ordinary message unless the user explicitly
selects an existing Thread again.

## Configuration

```sh
export IMZEN_APP_SERVER_URL=ws://127.0.0.1:4500
export IMZEN_CWD=/absolute/workspace
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
Server outcome is unknown. Conversation bindings deliberately remain in memory,
so this database is not a second Thread, transcript, queue, or Agent runtime.

`IMZEN_APP_SERVER_SHARED_FILESYSTEM_ROOT` is an explicit deployment
attestation that the external App Server can read that local directory. IMZen
passes local-image paths only when this setting is present, and the SDK rejects
every image outside the configured root. Leave it unset for remote or
unshared-filesystem App Servers. Channel `media_dir` values used for images
must be inside this root.

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
local-image input. QQ exposes text, file, and image as separate inbound message
shapes; IMZen accepts attachment-only file and image messages directly and
does not synthesize or join a caption from adjacent text messages. Markdown
Agent output is delivered unchanged.

## Migration behavior matrix

| Behavior                                    | Before                                  | After SDK migration                                             |
| ------------------------------------------- | --------------------------------------- | --------------------------------------------------------------- |
| QQ/Telegram/Feishu/Weixin lifecycle         | IMZen middleware over borrowed adapters | SDK-native Channel adapters and Gateway lifecycle               |
| Conversation binding                        | IMZen dictionaries                      | SDK `InMemoryBindingRepository`                                 |
| Thread/Turn calls                           | IMZen App Server wrapper                | SDK `ZenApplicationAdapter`                                     |
| Output projection and duplicate fencing     | IMZen local Gateway                     | SDK projection/idempotency pipeline                             |
| `/new`, `/permission`, approval aliases     | IMZen product behavior                  | Thin `ImZenController` over SDK actions/native profile seam     |
| `/model`                                    | IMZen product behavior                  | Explicit Zen native operation outside current typed contracts   |
| `/threads`, `/pick`, `/catchup`, `/history` | IMZen-specific parsing/list cache       | SDK Slash Controller and authoritative reads                    |
| Native Thread activation on `/pick`         | Resume side effect                      | Deliberately absent; binding and native activation are separate |
| Generic files and images                    | Text manifest + local image input       | Same behavior through SDK content-adapter seam                  |
| Processing failures                         | Middleware error message                | SDK classified failure phase + bounded IMZen presenter          |
| Durable queue/recovery state                | None                                    | None                                                            |

## SDK migration dependency

The pin is the complete SDK `main` commit after the focused rollout tracked by
[SDK issue #49](https://github.com/albert-zen/im-agent-sdk/issues/49). IMZen
composes immutable repository and extension groups. It configures only I1
inbound content transformation, I2 classified failure presentation, and request
presentation; A1/O1/O2 remain absent because this consumer has no product-owned
artifact materializer, destination presentation policy, or logical delivery
observer.

One upstream limitation remains explicit: the accepted App Server adapter API
keeps per-call native Thread profiles on the concrete
`create_thread_with_options` seam. A crash after native Thread creation but
before Conversation binding can therefore leave an unbound Zen Thread and a
redelivery can create another. Moving this product-specific profile through an
SDK pre-dispatch fence requires a future typed SDK operation; IMZen does not add
a local outbox or second creation authority to mask that gap. Likewise `/model`
is a Zen-specific native operation outside current SDK contracts, so ambiguous
transport failures are reported as “may already have applied” and same-value
retry is safe.

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
   native local-image input without synthetic text.
8. Stop the App Server or force a Turn failure; verify an explicit classified
   IM error and no self-repair queue.

This smoke test requires real QQ credentials and is intentionally not automated
or claimed as completed by the repository test suite.
