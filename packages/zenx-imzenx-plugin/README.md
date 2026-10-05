# IMZenX

IMZenX is a first-party ZenX plugin that runs the existing IMZen composition
inside the desktop Host lifecycle. QQ, Telegram, Feishu and Weixin are supplied
by the same pinned IM Agent SDK used by IMZen:
`7d5f1179365679d0f95abd5cb2ce76547238d05f` on the SDK's independent
`codex/im-input-failure-fix-sdk-compat` ref. This Git revision is not a PyPI
release or a merge to the SDK v1 main.

In direct Thread mode, IM and the desktop use **the same authenticated local ZAS and Thread**.
IM input becomes canonical user messages and Agent replies visible in ZenX;
Agent replies to desktop input are delivered to subscribed IM conversations.
No bot message is copied into a second transcript or Agent runtime.

## Install and configure

1. Use a ZenX build containing IMZenX, open Plugins, and install the built-in
   **IMZenX** entry. It is optional and is not auto-installed at startup.
2. Use the explicit **Prepare runtime** action to prepare Python 3.13 and the
   pinned SDK from this plugin's locked project. The Host copies the admitted
   project's source and lock into a private writable, lock-hash-addressed runtime
   directory; it does not write into signed application resources or alter a
   running consumer's environment. This requires official `uv` and read access
   to the private SDK repository. No install runs during plugin startup,
   preparation of settings, or readiness checking. Source-checkout alternative:
   `uv sync --project apps/imzen --locked --extra feishu` and select that
   environment's Python. Omit the Feishu extra when unused.
3. Use the native channel form for QQ, Telegram or Feishu/Lark. Only the fields
   declared by IMZenX's versioned provider schema are shown, verified against the
   pinned SDK's `from_config` contracts. Secret fields are local, write-only inputs
   saved through the Host's IM-owned encrypted credential vault; they are never
   Agent tool arguments. Saving an incomplete form is permitted and readiness
   reports missing required fields. Weixin needs this deployment's own existing
   SDK consumer-enrolled state directory, selected through the advanced private
   IMZen-format file flow. There is no cross-application or legacy import.
   Each deployment must use its own credentials and stop other bot consumers
   before connecting. Use `allowed_user_ids` or `allowed_conversation_ids` to
   restrict access.
4. Successful native runtime/channel preparation fills their nonsecret
   references automatically. Choose the working workspace, then **Check
   readiness**. Advanced settings also accept an explicitly selected Python
   executable and your own private IMZen-format channel file. Readiness inspects
   only that selection without saving or launching an IM transport. Missing SDK
   access remains an explicit prerequisite; nothing installs during inspection.
5. **Save settings** prepares only nonsecret paths and settings. New preparation
   defaults to `approval-required`. It does not connect, stop or restart a running
   consumer. Prepared settings cannot connect on Host restart or a ZAS status
   change until you explicitly connect. Before **Connect**, confirm that any other
   consumer using this bot has stopped. Native form credentials remain in the
   OS-encrypted IM-owned vault; advanced credentials remain in your private files.
   ZAS URL and bearer-token file come only from this Host.

Replacement preparation never connects to IM. After publication, activation waits
for all outstanding predecessor consumers to finish; failed or rolled-back
candidates do not consume messages. Each admitted Host generation captures an
isolated runtime instance. Disable → enable reloads the persisted configuration.

The page shows waiting for activation, unconfigured, prepared, waiting for ZAS, starting, connected or failed.
Connected means the SDK Gateway started, not that a real bot delivery has been
verified. Channel transport errors remain subject to the SDK's diagnostics and
native API delivery limits. After a failure, fix the configuration and use
**Reconnect**. No plugin-owned retry or recovery queue is created.

## Ordinary plugin tools

These tools are available through the normal plugin catalog to any Agent. PAW is
one preset using ordinary plugins; it has no separate IM setup tool or grants.
Normal Host permission and confirmation rules apply to every call:

The trusted native form rejects unavailable OS encryption and Electron's Linux
`basic_text`/unknown fallback rather than storing plaintext. Native setup IPC
requires the owned ZenX window's exact renderer page, not an iframe or a
navigated remote page. Explicit runtime setup retains its owned process through
timeout/shutdown until terminal closure, preventing overlapping retries.

- `imzenx_status` reads nonsecret saved and active settings plus connection state
- `imzenx_readiness` uses the `imzenx.inspect` permission for a bounded subprocess
  with the explicitly selected Python executable. Empty arguments inspect saved
  settings; a complete set of nonsecret configuration fields inspects an unsaved
  selection. It checks Python 3.13+, the SDK's pinned Git revision, the selected
  workspace and optional shared root, the Host server, and the existing IMZen
  channel/allowlist contract. It never constructs a Gateway or starts transport
- `imzenx_prepare` uses `imzenx.configure` to save only `pythonExecutable`,
  `channelsConfigFile`, `cwd`, optional `sharedFilesystemRoot`, `permissionMode`,
  and `allowUnrestrictedFullAccess`. Preparation stores an explicit-connect gate
- `imzenx_connect` uses `imzenx.connect`; configurations prepared with the new flow
  require `singleConsumerConfirmed: true` after a user/coordinator acknowledges
  that other bot consumers are stopped. Successful explicit Connect enables the
  existing Host restart/reconnection behavior. This is not delivery verification
- Existing `imzenx_configure` remains a save-and-connect compatibility tool using
  `imzenx.connect`. It cannot bypass a prepared configuration's single-consumer
  acknowledgement and requires the same field when the new flow has been used

For advanced file configuration, readiness reads only the selected own
IMZen-format file and its explicit QQ `credentials_file` reference, including
existing absolute and relative paths. For the native managed form, the Host
returns only supported channel IDs and safe configured/access flags; the Python
probe checks runtime/workspace without reading the managed marker or credentials.
The exact Host-owned marker is only a nonsecret selector. On explicit Connect,
the Host supplies the managed channel map to the Gateway through the existing
private child stdin, never process arguments, environment variables or tool
results. Trusted native channel edits acquire the runtime's same serialization queue,
persist the explicit-connect gate before changing the encrypted configuration, and
hold the queue until the write completes. Connect cannot interleave with a pending
save. A queued Connect acknowledgement becomes stale if selected settings change
or a managed edit finishes before it executes; a fresh review and explicit Connect
are required. This is only an in-memory admission fence, with no new persisted
coordination state. This registration exists only after predecessor retirement and is withdrawn
on close; an unpublished replacement cannot change the trusted runtime source.

It does not search other applications, home directories, or legacy configurations.
QQ's existing file contract is checked internally: user-owned private regular
non-symlink file, only `appid` and `appsecret`, decimal App ID, nonempty secret.
Existing SDK-native QQ configuration fields remain supported. Credential values,
allowlist values, raw parser errors and child diagnostics never enter tool results
or logs. Other channel credential schemas remain SDK-owned and are validated only
on explicit connection; readiness states that limit instead of guessing schemas.
The managed form reuses the existing Host credential vault with a separate
IM-owned file; it introduces no shared credential store or recovery mechanism.

Readiness returns `ready`, fixed `checks` with `id`, `status`, `message` and optional
`action`, supported `enabledChannels`, `singleConsumerConfirmationRequired`, and
`connectionState`. A ready local setup cannot prove bot exclusivity or real network
delivery. Status additionally reports `explicitConnectRequired`,
`singleConsumerConfirmationRequired`, `activeConfiguration`, and the Gateway-only
meaning of connected. Neither prepare nor readiness accepts bot secrets.

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

The Gateway launches Python in isolated mode with a constant bootstrap that adds
only this admitted plugin's source directory. The selected workspace remains the
working directory, but a workspace `imzen` package, user site path or `PYTHONPATH`
cannot shadow the trusted Gateway and receive its private configuration.

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
under Connection settings. Saving preserves a visible result; a connected Gateway keeps its original active
settings until explicit Connect. The saved configuration and active configuration
are reported separately so pending paths never appear to describe the running
consumer. Failed connections can be retried explicitly. Desktop discovery subscribes to new external Threads
without changing the selected Thread and feeds their first canonical input into
ZenX's existing automatic naming coordinator. Opening an older unnamed Thread
also supplies its first input; native and manually assigned names are preserved.

## PAW conversations

Use `/paws` to list existing PAW Rooms in the configured workspace and `/paw <number>` (or exact Room ID) to select one. The selection is local to the external IM conversation and survives restart. Ordinary text enters the canonical Room through its existing admission/steering mechanism. Only explicit agent Room posts are delivered back; private working-Thread output is never treated as an IM reply. `/new` clears the selection; `/threads` and `/pick` retain direct Thread mode.

The Host uses its existing private child pipe and scopes every Room read/post to the configured workspace. The bridge owns route selection and outbound checkpoints, not a transcript or runtime. Existing SDK channel restrictions and proactive-delivery limits still apply. No credentials, ports, grants or timers are created by selecting a PAW. PAW management, notebook and Trigger configuration remain in ZenX's existing workspace panel.

This first adapter supports text. Attachments and platform-native quoted replies, reactions and read indicators are not yet mapped; they must not be advertised as equivalent to Room context-consumption receipts. Mock verification does not certify real bot delivery.
