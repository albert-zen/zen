# IMZenX

IMZenX is a first-party ZenX plugin that runs the existing IMZen composition
inside the desktop Host lifecycle. QQ, Telegram, Feishu and Weixin are supplied
by the same pinned IM Agent SDK used by IMZen:
`57f255fb1f40a095aeabb5a6967380ba057494a3`.

IM and the desktop use **the same authenticated local ZAS and Thread**.
IM input becomes canonical user messages and Agent replies visible in ZenX;
Agent replies to desktop input are delivered to subscribed IM conversations.
No bot message is copied into a second transcript or Agent runtime.

## Install and configure

1. Use a ZenX build containing IMZenX, open Plugins, and install the built-in
   **IMZenX** entry. It is optional and is not auto-installed at startup.
2. Prepare Python 3.13+ with the pinned SDK. From a source checkout:
   `uv sync --project apps/imzen --extra feishu`. For a distributed plugin,
   extract its ordinary npm tarball and run `uv sync --project package/python
--extra feishu`. Omit the Feishu extra when unused. This requires read access
   to the private SDK repository and does not run automatically at installation.
3. Prepare a private IMZen-format channel configuration (see
   `python/README.md` in the tarball or `apps/imzen/README.md` in the checkout).
   Each channel must use this deployment's credentials. Do not share a bot with
   another running consumer. Use `allowed_user_ids` or
   `allowed_conversation_ids` to restrict access.
4. Open **IMZenX** in the sidebar. Set the absolute Python executable path
   (`.venv/bin/python`, or `.venv/Scripts/python.exe` on Windows), private channel
   configuration path, and default workspace; choose **Save and connect**.
   Bot secrets stay in private files. ZAS URL and bearer-token file come from
   this Host, not from an independently configured server.

Replacement preparation never connects to IM. After publication, activation waits
for all outstanding predecessor consumers to finish; failed or rolled-back
candidates do not consume messages. Each admitted Host generation captures an
isolated runtime instance. Disable → enable reloads the persisted configuration.

The page shows waiting for activation, unconfigured, waiting for ZAS, starting, connected or failed.
Connected means the SDK Gateway started, not that a real bot delivery has been
verified. Channel transport errors remain subject to the SDK's diagnostics and
native API delivery limits. After a failure, fix the configuration and use
**Reconnect**. No plugin-owned retry or recovery queue is created.

## Subscribe and continue

- `/threads` lists existing ZenX Threads by title and number; `/pick <number>`
  selects a Thread and receives its replies in the current IM conversation.
  Numbers refer to this conversation's last displayed list; after restarting,
  run `/threads` again before using a number. Refreshing replaces that list.
- One conversation selects one Thread. Several conversations can subscribe to
  the same Thread; each receives its own projection of subsequent Agent output.
- `/new` clears that conversation's binding and stops delivery for the old
  Thread. Its next ordinary input creates a new Thread. The old `/subscribe`
  and `/unsubscribe` commands retain their select/clear behavior as aliases.
- Ordinary IM input creates a Thread when none is selected, or continues the
  selected Thread. Open that Thread in ZenX to see canonical user messages and
  streamed Agent responses. Subscription never changes the desktop's selection.
- `/status`, `/history`, `/catchup`, `/model`, `/permission`, and approval commands
  retain IMZen behavior. Changing `/permission` clears the current binding;
  the new preset applies only to new Threads and resets to configuration on
  plugin restart.

Bindings, projection routes/checkpoints and inbound idempotency survive plugin
restart in SDK SQLite bridge storage under `userData/plugin-data/imzenx`.
The SDK performs bounded authoritative catch-up; this is not an unlimited
history archive. Channel/provider restrictions on unsolicited output still
apply (particularly bot reply windows and destination types).

Closing windows keeps the Host and plugin alive. Disable/uninstall/Quit closes
the child stdin and joins shutdown; a bounded timeout kills a stuck child.
ZAS lifecycle changes reconnect the bridge to the Host's new descriptor. An
unexpected Gateway exit remains failed until an explicit reconnect or a new
Host lifecycle. Configuration and bridge state are preserved by uninstall.

## Verification

`npm test --workspace @zenx/imzenx-plugin` checks process lifecycle and config.
`uv run --project apps/imzen --extra dev pytest -q apps/imzen/tests` checks
subscriptions, fan-out, unsubscribe, restart, deduplication and IMZen regressions.
`npm run test:imzenx --workspace @zen/zenx` exercises
real authenticated ZAS, the SDK Gateway, and the production desktop reducer;
only the IM transport and model provider are deterministic test doubles.
Real bot delivery requires a configured platform and credentials. The root
IMZen check runs this Python-dependent integration; Node-only ZenX checks do not
require a Python environment.

## Rollback

Disable or uninstall IMZenX in Plugins. This stops its process and subscriptions
without deleting ZAS Threads. Restore the prior ZenX application to revert the
Host integration; private plugin configuration and bridge SQLite are retained.

The management page shows connection state while open and keeps configured paths
under Connection settings. Saving preserves a visible result; failed connections
can be retried explicitly. Desktop discovery subscribes to new external Threads
without changing the selected Thread and feeds their first canonical input into
ZenX's existing automatic naming coordinator. Opening an older unnamed Thread
also supplies its first input; native and manually assigned names are preserved.
