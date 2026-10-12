import type { ZenXPluginManifestV2 } from "@zenx/plugin-sdk";

const device = {
  type: "string",
  description:
    "Configured machine ID from zenx_fleet_devices. Omit or use local for this Host. Never infer a machine from its description.",
};
const workspace = {
  type: "string",
  description:
    "Exact target workspace ID/path from zenx_fleet_workspaces; identities belong to that machine.",
};
const threadId = {
  type: "string",
  description:
    "Exact full Thread ID from this machine. Missing or archived IDs reject without title/prefix fallback. Supply either threadId or an explicitly fuzzy target, never both.",
};
const target = {
  type: "string",
  description:
    "Explicit fuzzy selector: unique ID prefix or exact title, scoped to the selected machine and workspace. Prefer threadId for a previously selected exact Thread.",
};
const limit = { type: "integer", minimum: 1, maximum: 100 };
const explicitDevice = {
  ...device,
  description:
    "Explicit configured remote HTTPS machine ID from zenx_fleet_devices. Required with an exact workspace and targetThreadId; for local work use the ordinary local tool. No implicit target or fallback.",
};
const targetThreadId = {
  type: "string",
  minLength: 1,
  description:
    "Exact existing target Thread ID whose current cwd, sandbox and approvals govern execution. Discover or create it on the selected machine first.",
};
const properties = {
  readiness: {},
  devices: {},
  probe: { device },
  workspaces: { device, limit },
  models: { device },
  threads_list: {
    device,
    workspace,
    query: { type: "string" },
    limit,
    cursor: { type: "string" },
    archived: { type: "boolean" },
  },
  threads_read: {
    device,
    workspace,
    target,
    threadId,
    granularity: {
      type: "string",
      enum: ["turns", "items", "agent_messages", "item"],
    },
    itemId: { type: "string" },
    turnId: { type: "string" },
    cursor: { type: "string" },
    maxTurns: { type: "integer", minimum: 1, maximum: 20 },
    maxItemsPerTurn: { type: "integer", minimum: 1, maximum: 25 },
  },
  threads_create: {
    device,
    workspace,
    model: {
      type: "string",
      description:
        "Exact model ID from that target's catalog; this is a Zen model, not an experimental Agent Provider engine.",
    },
    effort: { type: "string" },
  },
  threads_send: {
    device,
    workspace,
    target,
    threadId,
    text: { type: "string", maxLength: 32768 },
    messageType: {
      type: "string",
      enum: ["guidance", "follow_up", "replacement"],
    },
  },
  threads_status: { device, workspace, target, threadId },
  shell: {
    device,
    workspace,
    targetThreadId,
    command: { type: "string", maxLength: 32768 },
    timeout_ms: { type: "integer", minimum: 1, maximum: 120000 },
    max_output_bytes: { type: "integer", minimum: 1, maximum: 65536 },
  },
  tools: { device: explicitDevice, workspace, targetThreadId },
  execute: {
    device: explicitDevice,
    deviceKey: {
      type: "string",
      minLength: 1,
      description:
        "Exact top-level deviceKey returned by zenx_fleet_tools. Binds the discovered configured machine/access/endpoint; changed routes reject instead of silently rebinding.",
    },
    workspace,
    targetThreadId,
    processEpoch: {
      type: "string",
      minLength: 1,
      description:
        "Exact opaque target process epoch returned by zenx_fleet_tools. Never invent or reuse it across a Host restart.",
    },
    toolGeneration: {
      type: "string",
      minLength: 1,
      description:
        "Exact opaque generation of the selected tool entry returned by zenx_fleet_tools for this machine/workspace/Thread. Stale generations reject before execution.",
    },
    name: {
      type: "string",
      minLength: 1,
      description:
        "Exact tool name disclosed by that catalog; no guessed names or unavailable tools.",
    },
    arguments: {
      type: "object",
      description:
        "Arguments matching the target tool's exact discovered input schema. Routing metadata belongs to this facade, not these arguments.",
      additionalProperties: true,
    },
    yield_time_ms: { type: "integer", minimum: 1, maximum: 30000 },
    timeout_ms: { type: "integer", minimum: 1, maximum: 120000 },
    max_output_bytes: { type: "integer", minimum: 1, maximum: 65536 },
  },
  tool_status: {
    task_id: {
      type: "string",
      minLength: 1,
      description:
        "Exact opaque qualified task_id returned by zenx_fleet_execute. Preserve it unchanged; it identifies the target Host admission, not a local task.",
    },
  },
};
const descriptions: Record<keyof typeof properties, string> = {
  readiness:
    "Read nonsecret Fleet Host readiness, configured peers and timestamped checks, prerequisites and network limits. Does not scan, start hosting, connect, pair or issue invitations. A human uses Fleet settings for one-use invitations; codes, credentials and private keys are never returned.",
  devices:
    "Discover configured machines, user-authored usage descriptions, access and timestamped reachability checks. Descriptions are guidance, never grants. Checked reachable is not a permanently connected socket.",
  probe:
    "Perform one bounded read-only reachability check for an explicit machine. Test connections close after the check; no mutation or automatic retries.",
  workspaces:
    "Discover workspace identities on the selected machine. Remote identities must not be used as local paths.",
  models:
    "Discover the selected Host's existing Zen model catalog and exact IDs before creating a Thread.",
  threads_list:
    "List bounded Threads on one explicit machine and optional workspace. IDs are machine-scoped; no local fallback.",
  threads_read:
    "Read bounded public history from the selected machine and workspace. Read returns facts, not a second journal.",
  threads_create:
    "Create an idle Zen Thread on the selected machine in an explicit discovered workspace, optionally choosing that target's model/effort. Creation does not start work.",
  threads_send:
    "Send explicit work to a machine-scoped Thread. Acceptance does not prove completion; inspect status/read. Unknown delivery is not automatically retried.",
  threads_status:
    "Inspect the target machine's authoritative Thread/Turn status before declaring work complete.",
  shell:
    "Run one bounded shell command through the target Host's existing shell runtime. Requires separate Host/client shell opt-in, explicit workspace and existing targetThreadId. The target Thread's current sandbox and remembered tool permissions apply; remote interactive approval is not supported, so approval-needed calls reject. SSH targets without this capability reject; never use an arbitrary-tool or raw-spawn bypass.",
  tools:
    "Lazily read exact target tool schemas, per-tool eligibility/reasons and processEpoch/generation for one explicit machine/workspace/targetThreadId. Requires the separate Host and client tools grant. Does not execute, connect or broaden old shell grants. Ineligible result contexts are not callable. SSH targets without this capability reject.",
  execute:
    "Execute one exact catalog-disclosed tool on its target Host with unchanged arguments and exact deviceKey/processEpoch/toolGeneration. Requires the separate tools grant and target Thread sandbox/approvals. The target owns the task; preserve any qualified task_id for wait/status. Unknown delivery is never automatically rerun or sent to a fallback machine.",
  tool_status:
    "Observe the target Host's authoritative task admission using its unchanged qualified task_id. Observation never reruns work. Disconnection or Host restart can leave the outcome unavailable or unknown; an expired handle is not proof of failure or completion.",
};
const required: Partial<Record<keyof typeof properties, string[]>> = {
  probe: ["device"],

  threads_create: ["workspace"],
  threads_send: ["text"],

  shell: ["device", "workspace", "targetThreadId", "command"],
  tools: ["device", "workspace", "targetThreadId"],
  execute: [
    "device",
    "deviceKey",
    "workspace",
    "targetThreadId",
    "processEpoch",
    "toolGeneration",
    "name",
    "arguments",
  ],
  tool_status: ["task_id"],
};
export const fleetManifest: ZenXPluginManifestV2 = {
  schemaVersion: 2,
  id: "zenx-fleet",
  name: "Fleet",
  version: "1.0.0",
  description:
    "Choose machines, manage Zen Threads and discover exact target tools with explicit permissions.",
  compatibility: { zenx: ">=0.1.0 <0.2.0" },
  runtime: { type: "bundled", entry: "./dist/runtime.js" },
  mainDocument: `Fleet is an ordinary plugin for every Agent. Read this HOWTO through zenx_plugin before using its tools. Fleet routes to existing Zen Hosts; it has no special PAW authority and is independent of experimental Agent Provider engines.

Choose the machine the user requested. Use zenx_fleet_devices for configured IDs, user-authored descriptions, access and timestamped check facts; descriptions guide selection, never grant permission. If the user's machine choice is ambiguous, ask rather than infer a different target. Ordinary Host-projected tools stay local when device is omitted or local. Their optional device is Host routing metadata, not an added property of the underlying foreign tool schema. Remote work always needs an explicit discovered device, that machine's exact workspace, and an exact target Thread. Remote identities are not local paths or interchangeable Thread IDs. Never fall back to local or SSH after a target failure.

Use zenx_fleet_readiness for nonsecret setup facts and network limits; use zenx_fleet_probe for one explicit bounded reachability check. Discovery reports configured peers and last-checked facts, not arbitrary computers or a permanently connected socket. A human creates/imports one-use invitations in Fleet settings. Cross-network access needs an already trusted reachable HTTPS route/VPN or configured relay; Fleet does not scan, set up trust/networking or provide public rendezvous. A relay terminates TLS and can see forwarded data. Never request or disclose invitation codes, credentials, certificates or private keys through model tools. Missing, disabled, offline or unauthorized capabilities must be reported honestly.

Inspect zenx_fleet_workspaces and zenx_fleet_models on the selected machine. Prefer reading/status/messaging an existing exact Thread; create an idle Thread only when useful and authorized, then send explicit work. Creation and message admission are not completion. Read/send/status use exact threadId or an intentionally fuzzy target, never both; missing/archived exact IDs reject without title or prefix fallback. A target Agent uses its own model and tools. Read-only inspection creates no task. Remote Thread completion Triggers use exact discovered sourceDevice/sourceWorkspace/Thread identities and report source errors; public history is a bounded observation, not a mirrored journal.

For direct target-tool work, call zenx_fleet_tools only after selecting explicit device, workspace and targetThreadId. Its lazy disclosure returns deviceKey plus catalog.processEpoch, exact input schemas, per-tool eligible/reason facts and each selected tool entry's generation (pass this as toolGeneration) for that context; do not eagerly discover every peer or guess names. Call zenx_fleet_execute with unchanged device/deviceKey/workspace/targetThreadId, catalog.processEpoch as processEpoch, the selected generation as toolGeneration, the exact catalog name, and arguments matching that schema. deviceKey binds the discovered configured machine/access/endpoint; changed routes reject. For an ordinary Host-projected remote call, supply device plus target_context containing deviceKey, workspace, targetThreadId, processEpoch and toolGeneration; they remain routing metadata outside the foreign arguments. A lazily disclosed target-scoped proxy takes only its exact foreign arguments and the Host inserts the bound context. Facade routing fields stay outside the target arguments. Only entries with eligible=true can execute or become callable remote projections. run_code/composite/compaction, trusted UI, page/media/artifact-bearing tools and other unsupported result contexts are excluded from remote execution until an origin-aware adapter exists; the catalog marks excluded entries eligible=false with a reason. Only safe origin-tagged text/JSON results are supported; never open their remote paths locally. The catalog is not a promise that every tool is remotely available.

Generic catalog/execute/status need a separate Host tools opt-in and fresh client tools grant, distinct from Thread control and shell. Existing invitations, old grants and shell opt-in do not expand to tools access. Where only typed configuration supports this grant, explain that limitation instead of claiming a ready UI flow. Each call still uses the target Thread's current ToolEnvironment, cwd, sandbox and approvals. Approval-needed remote calls reject; the caller cannot answer an interactive target approval. Unsupported SSH generic-tool requests reject. zenx_fleet_shell keeps its narrower separate shell grant and existing target Thread boundary.

The target Host owns execution, deadlines, cancellation and any async task. Preserve the opaque qualified task_id returned by execute unchanged; ordinary wait observes/cancels that target admission and zenx_fleet_tool_status reads its authoritative status. There is no duplicate local task or second journal. An accepted/running result is not completion. After disconnect, reconnect only to observe the same admission; never automatically repeat a mutation after a lost response. Host restart or expired task observation can make the outcome unknown, not safely retryable. Inspect the target before deciding whether new work is authorized.`,
  provider: {
    id: "zenx-fleet-host",
    platforms: ["*"],
    interactionModes: ["background_safe"],
    capabilities: [
      "zenx.fleet.read",
      "zenx.fleet.control",
      "zenx.fleet.shell",
      "zenx.fleet.tools",
    ],
  },
  permissions: [
    {
      id: "zenx-fleet.read",
      title: "Read Fleet machines and Threads",
      description:
        "Discover configured machine descriptions, target catalogs and bounded public Thread history.",
      scope: "workspace",
    },
    {
      id: "zenx-fleet.control",
      title: "Control Fleet Threads",
      description:
        "Create Threads and send explicit work to user-configured remote Hosts within their own grants.",
      scope: "local-device",
    },
    {
      id: "zenx-fleet.shell",
      title: "Run explicit remote shell commands",
      description:
        "Request bounded target shell execution; the remote Host and device grant must separately allow it, and target sandbox/approvals still apply.",
      scope: "local-device",
    },
    {
      id: "zenx-fleet.tools",
      title: "Discover and execute explicit target tools",
      description:
        "Request exact target catalogs, tool execution and task observation within a separately enabled Host/client tools grant; target sandbox/approvals still apply. Shell grants do not include this access.",
      scope: "local-device",
    },
  ],
  tools: Object.entries(properties).map(([key, props]) => {
    const id = key as keyof typeof properties;
    const permission = ["tools", "execute", "tool_status"].includes(id)
      ? "tools"
      : id === "shell"
        ? "shell"
        : ["threads_create", "threads_send"].includes(id)
          ? "control"
          : "read";
    return {
      name: `zenx_fleet_${id}`,
      description: descriptions[id],
      inputSchema: {
        type: "object",
        properties: props,
        required: required[id] ?? [],
        ...(["threads_read", "threads_send", "threads_status"].includes(id)
          ? { oneOf: [{ required: ["threadId"] }, { required: ["target"] }] }
          : {}),
        additionalProperties: false,
      },
      permissions: [`zenx-fleet.${permission}`],
      interactionMode: "background_safe" as const,
      capabilities: [`zenx.fleet.${permission}`],
      maxOutputBytes: 524288,
    };
  }),
};
