# Always On Assistant preset and Fleet

The assistant is a preset over Rooms, Triggers and self-control/Fleet, not a new
runtime or scheduler. It is independent of any personal Work workflow.

Enable Rooms, Triggers and self-control. In Rooms choose **+ Always On Assistant**
and bind an existing Thread with the desired model and permissions. Human Room
messages need no mention. While the Thread works, new input is steered into the
same Turn for the next model cycle; idle Threads start work normally. Explicit
follow-up queueing remains available in thread tools when requested.

The preset instructs the assistant to post useful progress, questions and results
using `zenx_rooms_post_message`. Final Thread output is not copied to the Room.
Several user messages can join one Turn, and one Turn can send several updates or
none. Agent Room posts do not implicitly wake another assistant. This is a model
behavior preset, not a guarantee that every model will follow the instructions.
The fake/mock models prove delivery mechanics, not reasoning quality.

The assistant uses existing Thread watches, timer and signal Triggers to continue
work after waits. Remote watches carry exact sourceDevice/sourceWorkspace/Thread
identity and subscribe to native events, recovering observed canonical Turns after
reconnection. Watches and timers targeting an assistant Thread use the same
next-cycle delivery while preserving the explicit event prompt and Room destination.
Fleet also offers bounded immediate waits. There is no unsolicited periodic model loop.
Thread/Trigger facts persist normally; interrupted or unknown work must be
inspected before resuming. The preset does not automatically replay uncertain
side effects after restart.

Closing a window leaves the Host running; explicit Quit stops it. Disabling the
Room wake trigger stops future admission, not already running work. Paused
messages remain saved and are not automatically replayed.

## Fleet: existing tools, optional device

`zenx_self_control_devices` lists local and configured devices (configuration is not a
live online check). These existing tools accept `device`, defaulting to `local`:

- `zenx_projects_list`, `zenx_models_list`
- `zenx_threads_list`, `zenx_threads_read`, `zenx_threads_status`
- `zenx_threads_create`, `zenx_threads_send`
- `zenx_self_control_threads_wait` waits for a specific Turn for up to 30 seconds; a timeout
  explicitly remains pending. Read the Thread for the result.

A remote response is `{device, result}` so Thread IDs remain device-qualified.
New messages default to guidance during active work. `follow_up` explicitly
queues and `replacement` explicitly replaces. No shell/browser tool schema is
changed: the remote agent uses that machine's local tools.

### SSH setup

The SSH transport uses existing, user-configured OpenSSH access to a
Linux/macOS host with a POSIX login shell. Node 22.13+ and the built ZenX app with
its dependencies must be available there. Run ZenX normally on each Host.
The remote helper connects to that Host's authenticated loopback App Server.
It does not start another agent server or export its bearer credential.

Configure the route in **Settings → Fleet**, or put `fleet.json` in the ZenX user-data directory:

```json
{
  "version": 1,
  "devices": [
    {
      "id": "workstation",
      "label": "Workstation",
      "sshHost": "my-existing-ssh-alias",
      "access": "control",
      "command": [
        "node",
        "/absolute/path/to/zenx/out/main/fleet-bridge.js",
        "/absolute/path/to/zenx-user-data/runtime/app-server.json"
      ]
    }
  ]
}
```

Use `access: "read"` for a read-only route. The file is trusted administrator
configuration: do not let agents or untrusted files supply commands or
connections. `control` authorizes the configured route to create and send work
under the remote account's existing authority. SSH itself may allow broader
account access; this is not a replacement for SSH account restrictions.
The helper reads workspace configuration from `host-profile.json` beside the
`runtime` directory. Remote creation is restricted to configured projects, just
like local self-control.

Connections use batch mode and strict host-key checking. Configure SSH keys and
verify the host with your normal SSH client first; Fleet will not accept new
host keys or ask a model for passwords. Configuration survives app restarts;
SSH retains its own authentication. Each invocation reads the remote Host's
current descriptor, so a changed ephemeral local bearer after restart does not
require pairing again. Native HTTPS transport instead uses persistent, revocable
device grants stored securely on the client and as digests on the Host.

No credentials were configured on a user's real devices during development.
Fleet settings now include HTTPS pairing, hosting and revocation; mobile includes
saved devices, Threads and assistant Rooms; remote watches use native subscriptions.
The optional self-hosted relay supports outbound Host connections. See the complete
[connection and permission guide](../../../docs/fleet-assistant.md) and
[relay trust model](../../../docs/fleet-relay.md). SSH installation and real-device
certificate provisioning remain operator actions. Failure, disconnect, cancellation
or backend acknowledgement loss can leave mutation admission unknown: inspect the
exact target, never retry blindly or fall back to local execution.

## Credential-free testing

`test/fleet-integration.test.ts` starts two independent real Hosts and executes
the same Fleet bridge in fresh subprocesses over local pipes, standing in for
SSH transport. It verifies cross-Host listing, reading, creation, same-Turn
steering, bounded completion waits, offline failure and reconnection after Host
restart, without real model calls. Separate tests cover device routing and
read-only/invalid destination rejection. This does not prove a real SSH network,
SSH onboarding, on-device Android UI/TLS or online-model behavior. Native TLS,
relay isolation, grant restart/revocation, and remote completion → assistant
admission → explicit Room post have separate fake-provider integration tests.

The loopback mock model service remains available:
`node apps/zenx/scripts/mock-model-server.mjs` (normal text, tool calls, errors,
slow cancellation). It never forwards to a real model provider.
