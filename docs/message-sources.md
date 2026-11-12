# Message sources across Fleet Hosts

Source navigation reads the actual source conversation. Local sources retain the
existing local Thread / Trigger navigation. Verified remote sources open an
independent, read-only source panel showing the exact Host, workspace and Thread.
It does not change the main or side conversation or its draft. Older messages can
be loaded with the existing public-history cursor; truncated messages have an
explicit full-public-Item reader with character progress and next-part controls.
Public history is an observation, not a mirrored canonical journal.

## Explicit return binding

An incoming pairing's random `deviceId` is **not** an outgoing Fleet device ID.
Neither names nor matching Thread IDs are sufficient to select a return route.
For A to send a traceable message to B:

1. The user must already have paired A → B with Thread control and B → A with
   the intended read/control grant. This feature does not create credentials,
   pair either direction, enable hosting or expand an existing grant.
2. A's source Thread must belong to an explicitly shared workspace on A. The
   sending Host captures the real canonical Thread/tool-call identity, display
   name, Host ID and workspace ID. Both Hosts must support the new origin
   capability; incompatible receivers reject before sending.
3. On B, open Fleet settings → Agent message return routes. Select A's exact
   incoming client grant, the existing HTTPS connection back to A, and A's
   discovered source workspace. Review the displayed identities and confirm
   the binding. The save rechecks the incoming grant, outgoing credential,
   exact Host/device key and accessible workspace. Repeat in the other
   direction for symmetric source navigation on replies.
4. New messages capture the receiver-owned binding in their canonical sender
   metadata. Existing unbound messages are not rewritten and remain unavailable.

The nonsecret `fleet.json` `messageSources` entries contain `inboundDeviceId`,
`hostId`, `workspaceId`, `deviceId` and the exact `deviceKey` from Fleet discovery.
They are configuration, not credentials or durable coordination state. Labels
can change without changing identity. Endpoint, access, default workspace or
capability changes invalidate the pinned device key. Removing a binding,
revoking either grant, deleting/archiving the source, or losing access/offline
connectivity produces an explicit failure; no local, label or SSH fallback is
attempted. Binding a different peer requires another explicit human choice.

## Model tools and trust

The model receives the canonical receiving Thread/Item IDs and the sender's
provenance. `zenx_fleet_source_read` and `zenx_fleet_source_send` take the receiving
`threadId` and exact canonical `itemId`, not a route supplied in message text.
They reread the canonical receipt, revalidate the binding and both existing
grants, and read the exact source Thread before returning history or sending a
reply. Replying still requires the existing return control grant and normal
communication authorization. Admission is not completion; uncertain sends are
not retried automatically. Authenticated peer Thread/tool identities remain
peer-reported, never a verified local tool call or human authorization.

## Remote Trigger source settings

A Trigger source action in remote history reads its current public definition
on that exact Host/workspace and owner Thread. Same-name or same-ID local
Triggers are never selected. Missing, moved, disabled-plugin, archived-owner or
out-of-scope definitions fail explicitly. The panel is **read-only**: it does not
run, edit or delete a Trigger. Public fields include identity, prompt, type,
active state and scheduling/source selectors. Program commands and environment
values are not disclosed, and the panel says so; editing still belongs to the
owning Host's settings. `zenx_fleet_trigger_read` offers the same exact read to
models through the existing Fleet read grant.

## Verification boundary

Automated tests exercise two real loopback TLS Hosts with synthetic independent
pairing IDs and existing grants, exact model read/reply, canonical/public/model
metadata, revocation, reconfiguration and archived sources. An ephemeral local
fence covers the entire asynchronous source operation and the final native
socket write, including Host restart, workspace refresh, binding edits, grant
revocation/re-pairing and outbound credential replacement. File-generation
fingerprints stay in memory and are never sent to models/peers. Paginated and
full-Item reads carry the same fence across pre/post receipt validation. Renderer tests cover
remote settings, history paging and original text without local navigation or
writes. Screenshot evidence must use the actual renderer, identify synthetic
fixture data, and match the reviewed commit; DOM tests are not screenshot or
native-platform evidence.
