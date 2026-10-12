# Foreground headless Fleet Host

`zen fleet-host` is an intentional native TLS Host command for a machine without
ZenX. It composes the ordinary CLI's configured model provider with
`RemoteHostAccess`, `serveRemoteHost`, and `RemoteGrantFile`. It does not use an
experimental Agent Provider, SSH Agent loop, desktop runtime, or a second agent
implementation. The existing `app-server --remote-host-config` remains an isolated
fake-provider fixture with process-local grants; it is not this production route.

## Prepare explicit local configuration

This initial production headless command requires POSIX private-file validation.
It fails closed on Windows until a Windows ACL verifier is added; the independent
desktop Fleet route is unchanged.

Build the normal CLI with `npm run build`. Create a private directory owned by the
Host operator, a private configuration file, and a private TLS key. The certificate
must be trusted by each connecting device. There is no plaintext fallback,
automatic public bind, certificate-warning bypass, or automatic certificate
provisioning. This command verifies private owner/mode and regular-file/directory
properties on POSIX and rejects symlinked authority paths. Keep the state directory
and its ancestors under the operator's control.

Example `/home/operator/.config/zen-fleet/host.json` (file mode 0600; directory mode
0700). All paths are explicit, absolute paths on the target machine:

```json
{
  "enabled": true,
  "hostId": "workstation-01",
  "bindAddress": "127.0.0.1",
  "port": 4501,
  "tlsCertificateFile": "/home/operator/.config/zen-fleet/cert.pem",
  "tlsKeyFile": "/home/operator/.config/zen-fleet/key.pem",
  "grantFile": "/home/operator/.config/zen-fleet/grants.json",
  "pairCodeFile": "/home/operator/.config/zen-fleet/pair-code",
  "access": "read",
  "shellEnabled": false,
  "workspaces": [
    {
      "id": "work",
      "label": "Work",
      "cwd": "/home/operator/work"
    }
  ]
}
```

- `enabled` must be exactly `true`. Merely having a config file does not start it
- `hostId` must be a stable operator-selected alphanumeric/underscore/hyphen ID.
  Preserve it, the private grant file, and the Host data directory across restarts
- `bindAddress` must be an explicit IP address. Loopback is a safe example; it is
  reachable only from the target machine. Select a reachable interface deliberately
  if other machines should connect. No firewall, VPN, SSH trust, or OS setting is
  changed by this command
- `port` must be explicit. Use a fixed nonzero port for saved production clients;
  `0` is available for ephemeral loopback fixtures
- `grantFile` and `pairCodeFile` must have existing private parent directories.
  Existing grants must be a valid private regular file for this exact Host ID.
  The TLS key and authorization/config paths must be distinct
- The workspace allowlist must contain 1–32 existing absolute directories. Entries
  are resolved to real paths; duplicate IDs or directories fail configuration.
  These are Host-local paths. Clients receive IDs/labels for selecting target
  Threads. This allowlist is not an additional filesystem sandbox: actual tools
  retain the target Thread’s configured sandbox and approval policy
- `access` is explicit `read` or `control`. Read denies create/send/interrupt and
  shell. A client asking for read gets a read grant even on a control Host.
  Raising the Host mode alone does not upgrade an existing read grant; re-pair it
- `shellEnabled` is omitted or `false` by default. See the additional shell boundary
  below
- Optional `originEndpoint` admits one exact direct HTTPS authority for Android;
  include its explicit port, equal to the listener port, and use a hostname/IP in
  the certificate SAN. This does not enable pairing CORS. No relay is configured
  by this narrow headless command

## Select the normal CLI provider

For an existing OpenAI subscription profile in this explicit data directory:

```sh
zen auth login --data-dir /home/operator/.local/share/zen-headless
zen fleet-host \
  --config /home/operator/.config/zen-fleet/host.json \
  --data-dir /home/operator/.local/share/zen-headless \
  --provider openai-subscription \
  --model gpt-5.6-terra
```

For an OpenAI-compatible provider, provide the key through the same CLI environment
variable mechanism and select the model and a positive local context cap explicitly:

```sh
zen fleet-host \
  --config /home/operator/.config/zen-fleet/host.json \
  --data-dir /home/operator/.local/share/zen-headless \
  --provider openai-compatible \
  --base-url https://provider.example/v1 \
  --model provider-model-id \
  --context-window 32768 \
  --api-key-env ZEN_MODEL_KEY
```

Set `ZEN_MODEL_KEY` securely in the launching environment; do not place a key in the
Fleet JSON file or pairing logs. The provider key is removed from the inherited
process environment before tool runtimes are created. `--context-window` sets the
operator's local cap for each model in the configured `--models` catalog; it is not
a claim about a provider's advertised maximum. Subscription/fake presets already
carry local caps. `--provider fake` is supported for deterministic offline checks,
with no model-network request.

`--data-dir` must be explicit, absolute, private, and different from the CLI's
implicit `~/.zen` directory. The command will create a missing private data
directory. Do not run two Hosts against the same data directory or grant file.
`--cwd`, if supplied, must identify one allowlisted directory; otherwise the first
allowlisted directory supplies the Host default. There is no additional local
Codex WebSocket/stdio listener. `--listen`, `--remote`, bearer-file bridge options,
and the isolated fixture flag are rejected by this command.

## Pairing and local administration

Starting the Host does not open pairing automatically. Add `--pair` to this
invocation, or send `pair` to its local stdin while it runs. It creates a one-use
code in the explicitly configured private file; the code expires after five
minutes and is never printed in process output. Read that file locally and enter
the endpoint, stable Host ID and code into the connecting client's Fleet setup.
The client must trust this certificate normally. A loopback listener requires a
client on the target machine; use an intentionally reachable bind for another
machine.

The source Host authorizes only the current allowlisted workspaces. The grant
stores the client's token digest, access scope and shell opt-in outside the
conversation journal. The client stores its bearer token through its own supported
credential store. Do not distribute or log a grant file, bearer token, TLS key,
provider key, or subscription profile.

Local stdin commands (a terminal or intentionally supplied pipe):

```text
pair
status
devices
revoke <deviceId>
quit
```

`devices` lists non-secret device IDs/access/revocation state. `revoke` immediately
closes that device's native connections, cancels its shell calls and persists the
revocation for subsequent process starts. `pair` replaces only the pairing file
created by this process and invalidates the previous code. An unexpected preexisting
pairing file is not overwritten. After an ungraceful stop, inspect and remove a
stale code file yourself before explicitly asking for another code. Pairing-file
cleanup refuses to delete a different file substituted at the same path.

## Optional target shell

Shell requires all of these independent permissions:

1. The target Host JSON has `access: "control"` and `shellEnabled: true`
2. Fresh enrollment explicitly requests a control grant with shell enabled
3. The selected target Thread and workspace remain authorized and current
4. The target Host's own tool admission permits `shell`

Headless defaults to `--approval always`, so an unknown tool approval fails closed.
There is no interactive target approval UI in this command, and the caller cannot
answer target approval prompts. Choose `--approval never` explicitly only if the
operator intends Full Access for the target Host's tools. A legacy grant without a
shell opt-in stays shell-denied after restart; changing the Host flag alone does
not upgrade it.

The gateway is the same `FleetShellGateway` used by ZenX and is injected with this
Host's actual `ToolEnvironment`, not a free-standing command runner. The existing
Host shell runtime owns environment sanitization, sandbox/admission, task deadlines,
cancellation, output limits and spool capture. It does not start a target Agent Turn
or append a synthetic target conversation result. Normal remote Agent Turns still
run that target's model and tools under its configured policy.

## Process lifetime and durability

This is one foreground process. SIGINT, SIGTERM or `quit` stops its listeners,
interrupts active model Turns, cancels owned shell tasks and closes Host resources.
An attached stdin reaching EOF does not stop it. A graceful stop removes this
process's pairing file. It does not install a daemon, launch agent, scheduled task,
service, autostart setting or crash-recovery supervisor.

Pairing and revocation survive normal process restarts because grants are durable.
Threads survive in the ordinary append-only CLI journal. Those files do not keep
execution alive: stopping the process stops execution, and clients must reconnect
after a deliberately started replacement process. TLS/config changes take effect
at the next invocation. Keeping a machine continuously available or managing its
foreground process is a separate operator decision.

## Verification boundary

Focused tests launch the built CLI on throwaway loopback trusted-CA TLS with a
mock OpenAI-compatible server or fake provider. They exercise explicit startup
validation, model selection/request, canonical reply/recovery, durable read/control
pairing and revocation, active-stream shutdown, optional Host-owned shell,
target admission and legacy-shell denial. Shared desktop shell tests cover the
unchanged admission/cancellation/output mechanism after extraction.

These tests are not verification of a paid model, subscription login, Windows ACLs,
a physical second machine, mobile native builds, public reachability or a deployed
TLS identity. Perform those checks separately on the intended target using its
existing trust and connection setup.
