# Fleet and Always On Assistant

Fleet lets ordinary plugin tools work across configured desktop Hosts for any
Agent. The PAW (Always On Assistant) preset supplies default behavior and a memory
location; Rooms own messages, Triggers own wakeups, and Fleet owns device routing.
It has no privileged capability, private workspace convention or personal workflow
dependency.

## Desktop connection setup

Open Settings → Fleet. Use this UI for live changes; restart ZenX after manual
edits to fleet.json. Add an SSH device with an existing trusted SSH alias and
the remote packaged `fleet-bridge.js` command, or pair a native HTTPS Host using
the target user's reviewed single-use invitation. The invitation fills in its
endpoint and Host ID; the receiving user confirms trust and requested access.
Agents use `zenx_fleet_readiness` for nonsecret preparation checks and known-device
discovery. They never receive invitations, permanent tokens or authorization to
change trust silently. See [the invitation flow](fleet.md#connect-with-an-invitation).
Test the device and inspect its available
workspaces before choosing one. The remote workspace identity is returned by the
Host; a local path is not a remote workspace ID.

To expose this desktop, enable Fleet hosting, choose the bind address and port,
and supply a certificate and private key. Certificates must be trusted by the
connecting device; there is no certificate-warning bypass. For Android direct
connections, set the client-facing HTTPS endpoint with an explicit port matching
the listener and a hostname in the certificate SAN. This narrowly admits the
Origin emitted by React Native; it does not enable pairing CORS. Prefer a loopback
listener unless remote network access is intended. Read-only hosting cannot
create/send/interrupt or post Room messages. A desktop read-only enrollment also
narrows the server-issued grant, even when the Host allows control; upgrading
that grant requires fresh pairing. Control access permits those actions
under the Host's existing runtime policy. A Host may have additional approval
requirements.

Pairing grants persist across normal Host/app restarts until explicitly revoked.
The Host stores token digests in a private file; client secrets use the existing
OS-backed credential vault. Removing a saved connection removes its local secret;
revoke the client at the source Host to invalidate its grant. The running Host
owns execution. Closing a window can leave the app in the background; explicitly
quitting stops the Host. This feature does not install an operating-system daemon.

The optional self-hosted relay supports outgoing Host connections when direct
reachability is inconvenient. See [relay setup and trust boundaries](fleet-relay.md).
It is a trusted TLS terminator, not end-to-end encrypted messaging. It sees
forwarded grants and messages. No public relay service/account is required.

## Agent tools

Fresh desktop profiles install the ordinary Rooms, Triggers, self-control,
Subagents and Fleet packages through the same startup path. Explicit disabled or
uninstalled choices are preserved; preparation/configuration and tool permissions
still apply. IM is an optional independent plugin, not owned by the PAW preset.

Use `zenx_plugin` to discover/read `zenx-self-control`, `zenx-rooms` and
`zenx-triggers`, and the ordinary `zenx-fleet` package before calling their
undisclosed tools. Fleet's `mainDocument` owns the remote machine, transport,
capability and task HOWTO for every Agent. PAW only recommends reading that
guidance and respecting the user's requested machine; there is no second
Fleet instruction corpus in the preset.

- `zenx_self_control_devices` lists configured devices
- `zenx_threads_list`, `zenx_threads_read`, `zenx_threads_create`,
  `zenx_threads_send`, `zenx_threads_status` and
  `zenx_self_control_threads_wait` accept optional `device`; omission stays local
- Remote agents execute their own tools on their own Hosts
- Generic direct target tools are discovered lazily with `zenx_fleet_tools` for
  an explicit device/workspace/target Thread; `zenx_fleet_execute` uses that exact
  discovered device key, process epoch and selected tool generation
- Generic catalog/execute/task status need a separate tools grant; shell and
  existing invitation grants do not confer it. The initial grant uses typed
  configuration/enrollment rather than the current invitation/settings UI
- Read-only inspection does not create tasks
- Unknown delivery is not completion, and lost responses must not cause automatic
  replay of a mutation

For eligible text/JSON results and qualified target-owned tasks, follow
[the generic Fleet workflow](fleet.md#lazy-target-tool-catalog-and-execution).
Unsupported result contexts remain excluded from execution/callable projection;
the catalog reports their ineligible status and reason. Ordinary `wait` and
`zenx_fleet_tool_status` observe the same target admission; disconnection or Host
restart must not create a local duplicate or automatically rerun target work.

For a remote Thread completion Trigger, record `sourceDevice`, canonical
`sourceWorkspace` and the exact watched Thread. The existing Trigger service owns
activation, once/repeat behavior and history. Native subscriptions reconnect and
resync observed canonical Turns; they do not replay unrelated old completions.
Source errors are visible without inventing completion. Removing or changing a
connection invalidates its transient subscription.

## Assistant experience

Create an Always On Assistant Room bound to a Thread. Human messages start idle
work or steer its active Turn at the next model cycle. Consecutive messages can
belong to the same task. The assistant explicitly calls `zenx_rooms_post_message`
for useful answers, progress and questions; final Thread output is not copied
into the Room automatically. A Trigger can wake the same assistant when a remote
Thread finishes, with the source Room ID in its prompt.

The mobile client provides saved Fleet devices, workspaces, Threads and assistant
Rooms. Credentials are stored using SecureStore. Reconnect preserves the selected
conversation and draft; an uncertain send is never silently replayed. Room sends
use the epoch from a completed read plus a client UUID. The source Host remains
the authority for messages and work.

## Validation scope

Tests use deterministic fake providers and local trusted-CA TLS endpoints,
including pairing/restart/revocation, direct and relayed native operations,
subscriptions, mobile session races and Room idempotency. Native device builds,
public internet deployment and real-model behavior require their own environment
checks; a passing mock test does not establish those results.
