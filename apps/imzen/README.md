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
export IMZEN_CHANNELS_CONFIG_FILE=/absolute/private/channels.json
python -m imzen
```

`IMZEN_APP_SERVER_AUTH_TOKEN_FILE` may name a private file containing the
App Server bearer token.

The channel config is a JSON object. Enabled values are passed to the pinned
IMCodex adapter. IMZen can keep QQ credentials in its own private credential
file instead of copying another product's channel configuration:

```json
{
  "qq": {
    "enabled": true,
    "credentials_file": "/absolute/private/imzen/qq.json",
    "allowed_user_ids": ["none"]
  }
}
```

The QQ credential file contains only `appid` and `appsecret`, is owned by the
current user, and must be mode `600` on POSIX. `allowed_user_ids: ["none"]`
connects the bot while rejecting all inbound work; replace it with the owner's
QQ openid after observing the first denied message in the private log.

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
