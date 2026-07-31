# IMZen

IMZen is a thin, separate Python client of the Zen App Server. It reuses the
channel adapters from a pinned IMCodex commit, but it does not import the
IMCodex bridge, backend, store, or agent semantics.

The first version keeps conversation-to-thread bindings in memory. Restarting
IMZen therefore starts a new Zen thread on the next message. It never creates a
durable command queue, outbox, scheduler, or recovery state machine.

## Configuration

```sh
export IMZEN_APP_SERVER_URL=ws://127.0.0.1:4500
export IMZEN_CWD=/absolute/workspace
export IMZEN_PERMISSION_MODE=full-access
export IMZEN_ALLOW_UNRESTRICTED_FULL_ACCESS=true
export IMZEN_CHANNELS_CONFIG_FILE=/absolute/private/channels.json
python -m imzen
```

`IMZEN_APP_SERVER_AUTH_TOKEN_FILE` may name a private file containing the
App Server bearer token. `IMZEN_PERMISSION_MODE` accepts `full-access`
(the default) or `approval-required`. Full Access requests the only currently
supported sandbox (`danger-full-access`) with approval policy `never`; commands
can therefore access everything available to the IMZen host process without an
approval prompt. If an enabled channel has neither `allowed_user_ids` nor
`allowed_conversation_ids`, Full Access requires the explicit deployment opt-in
`IMZEN_ALLOW_UNRESTRICTED_FULL_ACCESS=true`; alternatively, configure an
allowlist. This opt-in is host configuration and never enters Zen Core or a
Thread.

The channel config is a JSON object. Enabled values are passed to the pinned
IMCodex adapter. IMZen can keep QQ credentials in its own private credential
file instead of copying another product's channel configuration:

```json
{
  "qq": {
    "enabled": true,
    "credentials_file": "/absolute/private/imzen/qq.json",
    "markdown_enabled": true
  }
}
```

The QQ credential file contains only `appid` and `appsecret`, is owned by the
current user, and must be mode `600` on POSIX. With no access restriction,
the pinned channel adapter accepts messages that the QQ platform delivers to
this bot. `allowed_user_ids` and `allowed_conversation_ids` remain optional
restrictions for deployments that need a narrower scope.

Use `/permission` to inspect the current conversation preset and
`/permission full-access` or `/permission approval-required` to change it.
Changing the preset starts a new Zen Thread on the next message because a
Thread's effective sandbox and approval policy are immutable history.

Use `/threads [query]` to list the central App Server's Threads, `/pick
<number|id|query>` to bind this IM conversation to one, and `/status` to inspect
the current binding. This is how an IM conversation can continue a Thread first
created through T3 Code or another App Server client. The binding and the most
recent list are display state held only in IMZen memory. `/threads` shows at
most 20 matches; use a query to narrow larger histories.

Use `/model` to list the central Zen host's ModelCatalog and `/model <name>` to
change the selected Thread for subsequent Turns. IMZen does not keep a separate
model setting: it calls the same App Server operation used by Zen CLI and T3
Code, and ZAS rejects changes while a Turn is active.

Supported keys at the top level are `qq`, `telegram`, `feishu`, and `weixin`.
Feishu additionally requires installing the `feishu` extra. Each IMZen
deployment owns its channel config and credentials; do not point it at
imcodex's live config or run two clients with the same bot credentials.

Zen's current 0.146.0 protocol subset accepts text input only. IMZen includes
downloaded file paths in a text manifest; image-only model input is not yet
supported and fails explicitly instead of being queued or retried.

## Verification

```sh
python -m pytest
ruff check .
```
