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
IMCodex adapter:

```json
{
  "telegram": {
    "enabled": true,
    "bot_token_file": "/absolute/private/telegram-token",
    "allowed_user_ids": ["123456"]
  }
}
```

Supported keys at the top level are `qq`, `telegram`, `feishu`, and `weixin`.
Feishu additionally requires installing the `feishu` extra.

An existing channel config created for another client of the same pinned
IMCodex channel version can be reused by pointing
`IMZEN_CHANNELS_CONFIG_FILE` at that private file. Do not run two clients with
the same bot credentials at the same time: stop the previous channel owner
before starting IMZen. Reusing the file does not import that client's
bindings, queues, agent state, or backend.

Zen's current 0.146.0 protocol subset accepts text input only. IMZen includes
downloaded file paths in a text manifest; image-only model input is not yet
supported and fails explicitly instead of being queued or retried.

## Verification

```sh
python -m pytest
ruff check .
```
