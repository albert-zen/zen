# Fleet machines and remote work

Fleet is a separate first-party ZenX plugin and desktop capability. It works with
ordinary target Zen Hosts and their current model catalogs. It does not depend on
experimental Agent Provider runtimes. Settings → Fleet configures SSH routes or
pinned HTTPS peers. Add a label and an optional machine description explaining
what the machine is for and when an Agent should use it. The description is
user-authored guidance, not a permission grant or executable command.

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
- `zenx_fleet_probe`: an explicit bounded reachability check
- `zenx_fleet_workspaces` and `zenx_fleet_models`: target-specific discovery
- `zenx_fleet_threads_list`, `read`, `create`, `send`, and `status`
- `zenx_fleet_shell`: the additional HTTPS shell capability described below

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

## Reachability and credentials

Settings **Test** opens a bounded connection and closes it afterward. **Reachable ·
checked <time>** records the latest check; it is not a persistent Connected label,
not a claim that the next mutation will succeed, and not a synchronization state.
Refresh Fleet rechecks public configuration/Host status while preserving unsaved
revision-bound edits. Rebase conflicted configuration explicitly before saving.

HTTPS pairing checks the configured endpoint's normal TLS trust and pinned stable
Host ID. Tokens are stored only through the operating-system encrypted credential
store, never in renderer state or public Fleet JSON. If OS encryption is
unavailable, pairing rejects before requesting a grant; enable/unlock the target
platform's normal credential store before pairing. Pair codes are one-use and
short-lived. Changing a local access/shell request cannot expand an existing
server-issued grant; remove that peer and enroll afresh under target-approved scope.

Hosting continues to require explicit exposure/control consent, operator-provided
TLS files, scoped workspaces and individually revocable clients. This feature does
not create keys, alter SSH trust, open firewalls or install services. Android direct
connections require the explicit Android-facing HTTPS endpoint matching the
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
