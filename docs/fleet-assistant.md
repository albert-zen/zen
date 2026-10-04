# Fleet and Always On Assistant

Fleet lets the same thread tools work across configured desktop Hosts. The
Always On Assistant preset combines Rooms, Triggers and self-control. It has no
private workspace convention or personal workflow dependency.

## Desktop connection setup

Open Settings → Fleet. Use this UI for live changes; restart ZenX after manual
edits to fleet.json. Add an SSH device with an existing trusted SSH alias and
the remote packaged `fleet-bridge.js` command, or pair a native HTTPS Host using
its endpoint, Host ID and one-time code. Test the device and inspect its available
workspaces before choosing one. The remote workspace identity is returned by the
Host; a local path is not a remote workspace ID.

To expose this desktop, enable Fleet hosting, choose the bind address and port,
and supply a certificate and private key. Certificates must be trusted by the
connecting device; there is no certificate-warning bypass. For Android direct
connections, set the Android-facing HTTPS endpoint with an explicit port matching
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

Use `zenx_plugin` to discover/read `zenx-self-control`, `zenx-rooms` and
`zenx-triggers` before calling their undisclosed tools.

- `zenx_self_control_devices` lists configured devices
- `zenx_threads_list`, `zenx_threads_read`, `zenx_threads_create`,
  `zenx_threads_send`, `zenx_threads_status` and
  `zenx_self_control_threads_wait` accept optional `device`; omission stays local
- Remote agents execute their own tools on their own Hosts
- Read-only inspection does not create tasks
- Unknown delivery is not completion, and lost responses must not cause automatic
  replay of a mutation

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
