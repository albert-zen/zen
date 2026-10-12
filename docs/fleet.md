# Fleet machines and remote work

Fleet is a separate first-party ZenX plugin and desktop capability. It works with
ordinary target Zen Hosts and their current model catalogs. It does not depend on
experimental Agent Provider runtimes. Settings → Fleet configures SSH routes or
pinned HTTPS peers. Add a label and an optional machine description explaining
what the machine is for and when an Agent should use it. The description is
user-authored guidance, not a permission grant or executable command.

## Connect with an invitation

Fleet is included in the ordinary first-party startup installation. Every Agent
can discover its tools through the plugin catalog; a PAW preset has no privileged
Fleet path. Explicit disable/uninstall choices and normal tool permissions remain
in effect. Installation alone grants no access to another machine.
The plugin's `mainDocument` owns machine-selection, transport, capability and task
HOWTO guidance. The PAW preset recommends reading it and respecting the user's
machine choice; it does not carry a second Fleet instruction corpus.

1. On the target, ask its Agent to run `zenx_fleet_readiness` and explain missing
   preparation. This read-only tool reports known machines, current hosting and
   nonsecret prerequisites. It does not connect, change settings or issue trust.
2. The target user opens Settings → Fleet and approves hosting through the
   existing controls. A trusted certificate, workspace scope and reachable
   direct HTTPS endpoint or trusted relay must already be configured. Agents may
   help prepare nonsecret settings; certificate/network/credential authorization
   remains with the user and their organization's policy.
3. In **Invite a client**, choose the configured endpoint and machine name,
   acknowledge the access offered, then choose **Create invitation**. Share it
   privately with the intended person. The invitation contains a five-minute,
   single-use code, endpoint and stable Host ID. Creating another replaces the
   previous code. Hiding clears the screen without cancelling the target code.
   Sharing confirmation is bound to the displayed Host and access/shell scope;
   changed configuration requires a refresh and fresh acknowledgment.
4. On the receiving machine, choose **Use invitation**. Review the Host ID with
   the target user or another trusted channel. Pairing defaults to read-only and
   shell off. After explicitly acknowledging the selected access, choose
   **Pair and check**. Saved tokens remain in the existing OS-encrypted vault;
   the invitation is cleared after this attempt, cancellation or expiry.
5. The receiving Agent can now discover the configured machine and its exact
   workspace/model catalog. Humans can choose it in New Thread or inspect it
   from Settings. A failed reachability check does not undo a successful pair;
   its outcome is shown separately.

Invitation encoding is for copying, not encryption or proof of identity. Keep it
out of Agent conversations and logs. Readiness/discovery tools never return its
code or permanent credentials. Neither side enrolls automatically. Access remains
individually revocable at the target, and read/shell upgrades require fresh pairing.

Fleet discovers configured devices, not arbitrary computers. Machines on unrelated
networks need an already reachable endpoint or configured relay; there is no
automatic public rendezvous, network scan, port forwarding or certificate setup.
Loopback endpoints reach only the receiving computer. SSH with existing trusted
access remains available through the device editor, and separate pairing codes
remain in the advanced hosting controls.

## Start and inspect work

New thread defaults to **This machine** and keeps the ordinary local Composer.
Choose a configured **Machine**, then one of that target's workspaces and models.
The target catalog supplies opaque model IDs and supported reasoning choices;
local model preferences are not copied onto another machine. Existing target
Threads are available in the same view. A read-only peer can browse/read existing
work but cannot create or send work.

**Start on selected machine** creates one idle Thread on that target, then sends
the task explicitly. After creation, its device route identity, Host ID (HTTPS),
workspace and Thread ID are fixed for the view. A disconnected, removed, revoked
or changed route produces an error rather than opening an identically named local
Thread. Machine/workspace changes before creation preserve the draft text. This
remote entry is text-only; local image attachments are preserved and block remote
send until removed or the draft returns to This machine.

The remote view is a bounded public snapshot, not a mirrored journal. Message
content is readable; public tool traces are expandable and private reasoning and
remote asset paths are not resolved against local files. Refresh reads from the
same target. While its reported status is active, a three-second read/status check
updates the view. A failed check stops polling and marks the last snapshot stale;
refresh deliberately after addressing authorization or connection errors.

Remote mutations are never automatically replayed. If create/send has an unknown
outcome, inspect the target before starting a new draft or issuing another task.
Leaving a view does not cancel already accepted remote Agent work. Send supports
the target's existing Add guidance, Queue next work, and Interrupt and replace
semantics. Acceptance is not completion. Existing Thread lifecycle remains owned
by the target Host.

## Model-facing tools

The ordinary `@zenx/fleet-plugin` package exposes:

- `zenx_fleet_devices`: local/remote IDs, labels, descriptions, access and check facts
- `zenx_fleet_readiness`: read-only hosting/prerequisite facts and honest setup limits
- `zenx_fleet_probe`: an explicit bounded reachability check
- `zenx_fleet_workspaces` and `zenx_fleet_models`: target-specific discovery
- `zenx_fleet_threads_list`, `read`, `create`, `send`, and `status`
- `zenx_fleet_shell`: the additional HTTPS shell capability described below
- `zenx_fleet_tools`: a lazy exact-context target tool catalog
- `zenx_fleet_execute`: exact catalog-generation target tool execution
- `zenx_fleet_tool_status`: observation of a qualified target task handle

Thread operations delegate to existing self-control/target native Thread tools.
Use exact target workspace and Thread identities. For read/send/status, `threadId`
is the exact full-ID selector and never expands to a title or prefix when missing.
The explicit `target` selector preserves intentional fuzzy lookup; supply exactly
one selector. Archived exact selections reject. Native Host reads/recovery check the canonical
archived state, and remote message admission requires an unarchived target under
the existing Thread mutation lock; an archive that wins before admission produces
no new user/queue/Turn write. Existing callers retain their default behavior.
Settings Browse also pins its
captured route key; changing a route/access/workspace closes stale inspection and
invalidates its previous reachability check. The omitted device defaults to
local for the ordinary Thread tools; shell requires an explicit remote device.
Machine descriptions cannot override either side's permissions.

## Lazy target tool catalog and execution

An ordinary Host-projected routing call without `device`, or with
`device: "local"`, stays on
this Host. The optional selector is Host-owned projection/routing metadata; it
does not rewrite the underlying plugin/external schema. A foreign schema's own
fields remain foreign arguments. Respect the user's requested machine rather
than inferring a different destination from a description or a previous task.

For generic remote execution, use this sequence:

1. Read Fleet through `zenx_plugin`. Discover a configured machine with
   `zenx_fleet_devices`, then its workspace and exact existing target Thread. An
   authorized `zenx_fleet_threads_create` creates an idle Thread if one is needed;
   creation itself does not start a task.
2. Call `zenx_fleet_tools` with all of `device`, `workspace`, `targetThreadId`.
   Discovery is lazy for this explicit context; it does not eagerly copy all
   peers' schemas into every Agent's initial tools.
3. Select an entry with `eligible: true`. Use the disclosure's top-level
   `deviceKey`, `catalog.processEpoch`, that entry's opaque `generation`, its
   `definition.name`, and its exact `definition.inputSchema`. Call
   `zenx_fleet_execute` with those same identities and exact `deviceKey`,
   `processEpoch`, `toolGeneration: <entry.generation>`, `name`, and schema-valid
   `arguments`.
   Facade routing metadata stays outside `arguments`. `deviceKey` binds the
   discovered configured machine/access/endpoint; changed routes reject before
   execution. Stale generations and a different Host process epoch also reject;
   refresh deliberately before a new call.
4. Inspect the result's target origin and task status. Preserve a returned
   qualified opaque `task_id` unchanged for ordinary `wait` or
   `zenx_fleet_tool_status`. `wait` can observe or request cancellation of that
   same target admission. Acceptance/running is not completion.

Ordinary Host-projected remote calls supply `device` plus `target_context` with
all of `deviceKey`, `workspace`, `targetThreadId`, `processEpoch`, and
`toolGeneration` from that exact disclosure. These are routing metadata, removed
before the target foreign tool receives its own arguments. A lazy target-scoped
proxy exposes only the exact foreign schema; its Host inserts the bound route
context, including `deviceKey`. A foreign schema that owns a routing field keeps
that field unchanged; use its target-scoped proxy or the generic facade instead
of treating its own field as routing metadata.

Catalog, execute and tool status use the separate `zenx-fleet.tools` permission
and `zenx.fleet.tools` capability. The configured HTTPS control device, target
control Host and fresh server-issued client grant must separately opt into
`toolsEnabled`. Existing shell access, control grants and invitations do not
expand automatically. This first generic slice supports the grant through typed
configuration/enrollment; the current desktop invitation/settings UI does not
request tools access. Do not claim that clicking its shell checkbox enables all
tools. SSH generic-tool requests reject before bridge launch. The narrow shell
gateway and its existing grant remain independent.

The catalog reports exact schemas and eligibility. Excluded entries have
`eligible: false` with a reason and do not become callable remote projections.
Only tools whose text/JSON results are safely representable with their origin
can execute remotely. `run_code`, composite/compaction, trusted UI and
page/media/artifact-bearing tools remain excluded from execution until an
origin-aware adapter exists. Runtime eligibility is explicit: installed tools
are not automatically eligible, and Fleet does not promise every tool. Exact target schemas are
disclosed only for the selected target context. Origin-tagged text/JSON may
mention paths, but clients must never resolve them against local files.

The target Thread's current ToolEnvironment, cwd, sandbox and approval policy
remain authoritative. The facade does not spawn a raw process, synthesize a
target Agent Turn or bypass remembered denials. There is no remote interactive
approval path; approval-needed calls reject explicitly. Argument JSON is bounded
to 48 KiB; optional `yield_time_ms` is 1–30000, `timeout_ms` is 1–120000 and
`max_output_bytes` is 1–65536. Admission IDs and their acceptance timestamps are
minted by the Host, not supplied by the model.
New tool tasks capture the target's canonical root before the Thread dispatch
fence awaits metadata. Immediately before registration, that same synchronous
launch checks the live workspace mapping, canonical root and device grant.
Workspace removal or remapping, including symlink changes, rejects before a new
task starts. A Promise-returning Host workspace provider remains usable for
catalog and observation reads, but new generic execution rejects
`operation_forbidden` because it cannot supply synchronous workspace authority.

The target manager resolves ordinary-tool timing using its existing precedence:
declared domain timing arguments, runtime policy defaults, then configured
manager defaults. Remote observation/execution budgets are ceilings over those
resolved values, so a longer facade budget never lengthens a target deadline or
yield interval. Valid runtime/manager defaults above a remote ceiling are capped.
Explicit domain values outside the remote supported range still reject before
execution, as do effective target timings that Core rejects (including zero,
non-finite and out-of-Core-range values); they are never coerced into defaults.

The target Host owns the actual async task, deadline, cancellation and captured
output. The calling Host records its ordinary canonical tool result; it does not
create a duplicate local task or a second remote journal. After a disconnect,
observation can reconnect to the same admission. Keep the returned opaque handle
unchanged: it also preserves output and receipt-replay bounds after an interrupted
observation. It must never replay the mutation or silently switch to local/SSH. Host restart and expired admission/task
retention can make the outcome unknown; an unavailable observation is not proof
that execution failed, succeeded or is safe to repeat. Inspect the target's
authoritative state before deciding whether new work is authorized.

## Reachability and credentials

Settings **Test** opens a bounded connection and closes it afterward. **Reachable ·
checked <time>** records the latest check; it is not a persistent Connected label,
not a claim that the next mutation will succeed, and not a synchronization state.
Refresh Fleet rechecks public configuration/Host status while preserving unsaved
revision-bound edits. Rebase conflicted configuration explicitly before saving.

HTTPS pairing checks the configured endpoint's normal TLS trust and pinned stable
Host ID. Tokens are stored only through the operating-system encrypted credential
store, never in renderer state or public Fleet JSON. If OS encryption is
unavailable, pairing rejects before requesting a grant; enable/unlock the receiving
platform's normal credential store before pairing.
On Linux, Electron's `basic_text` or unknown backend is unavailable for Fleet
credentials even if its generic encryption flag is true; a normal OS secret store
is required. See [Electron's storage semantics](https://www.electronjs.org/docs/latest/api/safe-storage#synchronous-api).
Pair codes are one-use and short-lived. Changing a local access/shell request cannot expand an existing
server-issued grant; remove that peer and enroll afresh under target-approved scope.

Hosting continues to require explicit exposure/control consent, operator-provided
TLS files, scoped workspaces and individually revocable clients. This feature does
not create keys, alter SSH trust, open firewalls or install services. Android direct
connections require the explicit client-facing HTTPS endpoint matching the
certificate SAN and listener port. An optional trusted self-hosted relay terminates
TLS and can see relayed pairing/messages/credentials; it is not end-to-end encrypted.

## Explicit shell boundary

Shell is independent of ordinary Thread control. It requires the target Host's
shell checkbox, a fresh control grant explicitly enrolled with shell access, the
saved HTTPS device's shell request, and an authorized **workspace** plus existing
**targetThreadId**. Legacy/read-only grants remain shell-denied. SSH shell is not
supported by this initial explicit gateway and rejects before bridge launch; SSH
thread operations continue to work.

The request runs through that target's actual `ToolEnvironment` and existing shell
runtime using the target Thread's cwd, sandbox and current approval policy. Target
remembered denials remain authoritative. There is no standalone interactive remote
approval route: an unknown approval is rejected with an actionable target approval
error. Fleet does not manufacture a new target Agent turn or append a target
transcript event for this tool request. The calling Agent's ordinary canonical tool
result records the response.

Commands are bounded to 30 seconds by default (1–120000 ms), with a bounded output
preview (1–65536 bytes, default 16384) and explicit truncation. Cancel, socket close,
revocation and deadline cancellation remain scoped to the existing target shell
task. No command is automatically restarted after a lost connection. An error or
cancelled request may have partial target effects; inspect before another command.

For machines without ZenX, see [foreground headless Host](fleet-headless.md). It
uses existing provider configuration and protected durable grants, while serving
only for the explicitly launched process's lifetime. Its initial private-path
validator is POSIX-only; it fails closed on Windows.

## Reference and verification

The implementation consulted T3's pinned
[connection-runtime boundaries](https://github.com/pingdotgg/t3code/blob/5cc99e1c23980d7995a13c47f969b47cb68ed1be/docs/internals/connection-runtime.md)
and
[environment selector](https://github.com/pingdotgg/t3code/blob/5cc99e1c23980d7995a13c47f969b47cb68ed1be/apps/web/src/components/BranchToolbarEnvironmentSelector.tsx).
The relevant ideas are explicit target identity, immutable Thread environment,
separation of reachability from fresh data, and no mutation replay. Fleet does not
import T3's relay/account/backend implementation.

Automated fixtures exercise two real loopback TLS Hosts with distinct fake model
catalogs and canonical journals, plus permission/identity/revocation/cancellation
cases. Native desktop smoke uses a labeled mock SSH launcher to two real loopback
Hosts. This is not proof of cross-physical-machine SSH/LAN/public access. The cloud
GUI's OS encrypted storage is unavailable, so successful HTTPS vault enrollment is
not claimed there; TLS and enrollment protocol tests use throwaway protected fixture
stores separately. Real model billing, operator TLS deployment, native Android
builds and physical-machine connectivity require checks in the intended environment.
