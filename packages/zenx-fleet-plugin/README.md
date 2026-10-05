# Fleet

An ordinary first-party plugin that discovers user-configured machines and their usage descriptions, inspects each target's Zen workspaces/models/Threads, creates/sends explicit work, and lazily discovers target tool eligibility without changing execution authority. Every Agent reads the same Fleet-owned HOWTO through `zenx_plugin`; PAW has no private routing path.

Descriptions are guidance only. Discovery reports last-checked reachability, never an implied permanent live connection. Use machine-scoped workspace and Thread IDs; a failed target operation does not fall back to this machine.

`zenx_fleet_readiness` reads nonsecret Host state, configured peers and their existing checks, credential-encryption/TLS prerequisites, and network limits. It does not start hosting, probe machines, scan networks, pair devices or return configuration credentials, invitation codes, certificate contents or private keys. This ordinary read tool works through the same Fleet permission for any Agent.

A human can create a one-use invitation in Fleet settings after enabling the Host and confirming sharing. Consent binds the displayed settings revision, Host identity, access, effective shell scope and relay endpoint. Changed facts require a refresh and another review; the live Host checks its own scope atomically before issuing or replacing a code. The endpoint must already match the current direct listener, the configured client-facing HTTPS endpoint, or the configured connected relay. Invitations carry Host identity, endpoint, a label, current access/shell policy and a five-minute pairing code. The opaque paste value is a bearer secret, not encryption or proof of trust. The recipient must independently verify Host identity and trusted HTTPS certificate/address before pairing; imported policy does not grant additional authority. The existing target grant remains the one-use authority, and issuing a new code replaces the previous one. Invitations are not persisted or available through model tools.

Only configured peers are discovered. Across networks, the user must arrange a reachable trusted HTTPS route/VPN or an already configured relay; Fleet does not set up routers, certificates, VPNs or public rendezvous. A relay terminates TLS and can see pairing, requests and events; it is not end-to-end encryption. Listener state, invitation creation and an earlier successful check do not prove reachability from another client. Loopback endpoints are for clients on the same machine.

Shell is a separate permission. A target Host and fresh device grant must opt in; target Thread sandbox/tool approvals remain authoritative. No remote interactive approval route is claimed. Unsupported SSH shell targets reject explicitly. Unknown mutation outcomes are not retried automatically.

## Choose and discover the exact target

Respect the user's requested machine. Discover its configured ID, then its exact workspace and an existing target Thread. Descriptions help choose a machine but do not grant access. Ordinary Host-projected tool calls omit `device` for local work; this routing field is Host-owned metadata, not an edit to a foreign tool's schema. Generic Fleet calls require all three explicit fields: `device`, `workspace`, `targetThreadId`.

`zenx_fleet_tools` returns a lazy target catalog for that context. Select an entry with `eligible: true`. The catalog also reports excluded entries with `eligible: false` and a reason; those do not become callable proxies. Use the disclosure's exact top-level `deviceKey`, `catalog.processEpoch`, and selected entry's `generation`, its exact `definition.name` and `definition.inputSchema`. `zenx_fleet_execute` requires that same `deviceKey` along with the explicit target identities, `processEpoch` and `toolGeneration`, the exact `name`, and schema-valid `arguments`. `deviceKey` binds the discovered machine/access/endpoint; a changed route rejects before execution. Routing fields remain outside `arguments`. Do not enumerate every peer in advance, guess tool names, copy local schemas onto a target, or reuse a generation after replacement/restart. For ordinary Host-projected remote tools, `device` and `target_context` are routing metadata: the context requires `deviceKey`, `workspace`, `targetThreadId`, `processEpoch` and `toolGeneration` from the disclosure. A lazy target-scoped proxy exposes the exact foreign schema and the Host inserts this bound context.

Catalog, execute and `zenx_fleet_tool_status` require the independent `zenx-fleet.tools` permission/capability and a separately enabled control Host/client tools grant. Shell opt-in, Thread control, existing invitations and legacy grants do not confer tools access. The initial generic grant is available through typed configuration/enrollment only; the existing invitation/settings flow does not request it. Unsupported SSH generic-tool targets reject. Target sandbox and approvals still apply; approval-needed calls reject rather than asking the caller to approve target work.

Only explicitly eligible safe text/JSON result contexts can cross this boundary. `run_code`, composite/compaction, trusted UI and page/media/artifact-bearing tools are excluded from execution and callable projection until an origin-aware adapter exists. Catalog entries retain their explicit ineligible status and reason. A catalog is not a promise that every tool can execute remotely. Returned text/JSON retains target origin; a remote path must never be opened as a local file.

Execution bounds are `yield_time_ms` 1–30000, `timeout_ms` 1–120000 and `max_output_bytes` 1–65536. Argument JSON is limited to 48 KiB. The Host mints admission IDs and acceptance timestamps; they are not model-controlled fields.

## Observe the target-owned task

The target Host owns the tool task, deadline, cancellation and output. If execute returns a qualified opaque `task_id`, preserve it unchanged for ordinary `wait` or `zenx_fleet_tool_status`. A local duplicate task or second journal is not created. Acceptance and a running receipt are not completion.

A disconnected observation may reconnect to the same admission; it must not rerun a mutation. Host restart or expired admission/task observation can leave the outcome unknown. Inspect authoritative target state before deciding whether a new call is authorized. Failure never changes the target to local or SSH.

See [Fleet usage](../../docs/fleet.md#lazy-target-tool-catalog-and-execution) for the complete workflow and setup boundaries.
