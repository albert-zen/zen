import path from "node:path";
import { readThreadHistory } from "../thread-history.js";
import { createHash } from "node:crypto";
import { textFromUserInput } from "../../../../../src/item.js";
import { resolveThreadTarget } from "../thread-target.js";

import type { ToolInvocation } from "../../../../../src/tool.js";
import type { CanonicalItem, UserInput } from "../../../../../src/item.js";
import type {
  ClientRequestMethod,
  ClientRequestParams,
  ClientRequestResults,
  Thread,
} from "../../protocol-client/index.js";
import type { ZenXPluginManifestV2, ZenXCapabilityPackage } from "./types.js";
import { ZenXProjectProjection } from "../project-projection.js";
import type { WorkflowCommand } from "../workflow-configuration.js";

export const ZENX_SELF_CONTROL_CAPABILITY_ID = "zenx-self-control";
export const ZENX_SELF_CONTROL_WORKSPACE_PERMISSION =
  "zenx-self-control.workspace-read";
export const ZENX_SELF_CONTROL_LOCAL_DEVICE_PERMISSION =
  "zenx-self-control.local-device-control";

type SelfControlRequestMethod = Extract<
  ClientRequestMethod,
  | "zen/thread/read"
  | "model/list"
  | "thread/settings/update"
  | "turn/queue"
  | "thread/list"
  | "thread/start"
  | "thread/read"
  | "thread/name/set"
  | "thread/archive"
  | "thread/unarchive"
  | "turn/start"
  | "turn/steer"
  | "turn/replace"
>;

export interface AppServerRequestPort {
  readonly projectProjection: ZenXProjectProjection;
  request<M extends SelfControlRequestMethod>(
    method: M,
    params: ClientRequestParams[M],
  ): Promise<ClientRequestResults[M]>;
}

export interface WorkflowConfigurationPort {
  workflowConfiguration(): Promise<{
    revision: number;
    commands: WorkflowCommand[];
    titlePrompt?: string;
  }>;
  saveWorkflowConfiguration(value: {
    baseRevision: number;
    commands: WorkflowCommand[];
    titlePrompt?: string;
  }): Promise<void>;
}

interface AppServerRequestTarget {
  request<M extends SelfControlRequestMethod>(
    method: M,
    params: ClientRequestParams[M],
  ): Promise<ClientRequestResults[M]>;
  completePluginTurn?(
    threadId: string,
    input: string | UserInput,
  ): Promise<{
    threadId: string;
    turnId: string;
    items: readonly CanonicalItem[];
  }>;
}

export class MutableAppServerRequestPort implements AppServerRequestPort {
  #target: AppServerRequestTarget | undefined;
  readonly projectProjection: ZenXProjectProjection;

  constructor(projectProjection = new ZenXProjectProjection()) {
    this.projectProjection = projectProjection;
  }

  async attach(
    target: AppServerRequestTarget,
    configuredWorkspace?: string | null,
    configuredWorkspaces: readonly string[] = [],
  ): Promise<void> {
    this.#target = target;
    if (configuredWorkspace !== undefined) {
      await this.projectProjection.updateConfiguration(
        configuredWorkspaces,
        configuredWorkspace,
      );
    }
  }

  detach(target?: AppServerRequestTarget): void {
    if (target !== undefined && target !== this.#target) return;
    this.#target = undefined;
  }

  async request<M extends SelfControlRequestMethod>(
    method: M,
    params: ClientRequestParams[M],
  ): Promise<ClientRequestResults[M]> {
    if (this.#target === undefined) {
      throw new Error("ZenX self-control App Server port is not attached");
    }
    return await this.#target.request(method, params);
  }

  async completeTurn(
    threadId: string,
    input: string | UserInput,
  ): Promise<{
    threadId: string;
    turnId: string;
    items: readonly CanonicalItem[];
  }> {
    if (this.#target?.completePluginTurn === undefined) {
      throw new Error("ZenX plugin App Server port is not attached");
    }
    return await this.#target.completePluginTurn(threadId, input);
  }
}

const SOURCE = "zenx.app-server";
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const DEFAULT_READ_TURNS = 5;
const MAX_READ_TURNS = 20;
const DEFAULT_READ_ITEMS = 20;
const MAX_READ_ITEMS = 25;
const MAX_TEXT_LENGTH = 1_000;
const MAX_SEND_TEXT_LENGTH = 100_000;

const manifest: ZenXPluginManifestV2 = {
  schemaVersion: 2,
  id: ZENX_SELF_CONTROL_CAPABILITY_ID,
  name: "ZenX self-control",
  version: "1.0.0",
  description:
    "List derived workspaces and control Zen Threads through typed App Server requests.",
  compatibility: { zenx: ">=0.1.0 <0.2.0" },
  runtime: { type: "bundled", entry: "zenx/self-control" },
  mainDocument:
    "Use ZenX self-control to inspect projects and manage Threads through the canonical App Server.",
  provider: {
    id: "zenx-app-server",
    platforms: ["*"],
    interactionModes: ["background_safe"],
    capabilities: [
      "zenx.projects.read",
      "zenx.threads.read",
      "zenx.threads.control",
    ],
  },
  permissions: [
    {
      id: ZENX_SELF_CONTROL_WORKSPACE_PERMISSION,
      title: "Read Zen workspaces and Threads",
      description:
        "Read configured workspace metadata and bounded canonical Thread projections.",
      scope: "workspace",
    },
    {
      id: ZENX_SELF_CONTROL_LOCAL_DEVICE_PERMISSION,
      title: "Control local Zen Threads",
      description:
        "Create, rename, archive, or unarchive local Threads and start, steer, or replace their active Turns through App Server.",
      scope: "local-device",
    },
  ],
  tools: [
    {
      name: "zenx_models_list",
      description:
        "Discover the current model IDs, supported reasoning efforts and defaults from the App Server model catalog.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      permissions: [ZENX_SELF_CONTROL_WORKSPACE_PERMISSION],
      interactionMode: "background_safe",
      capabilities: ["zenx.threads.read"],
      maxOutputBytes: 512 * 1024,
    },
    {
      name: "zenx_threads_configure",
      description:
        "Select an existing model and optional reasoning effort for a Thread. Discover choices using zenx_models_list; App Server validates availability and active-work constraints.",
      inputSchema: {
        type: "object",
        properties: {
          ...targetProperties(),
          model: { type: "string" },
          effort: { type: "string" },
        },
        required: ["target", "model"],
        additionalProperties: false,
      },
      permissions: [
        ZENX_SELF_CONTROL_WORKSPACE_PERMISSION,
        ZENX_SELF_CONTROL_LOCAL_DEVICE_PERMISSION,
      ],
      interactionMode: "background_safe",
      capabilities: ["zenx.threads.control"],
      maxOutputBytes: 512 * 1024,
    },
    {
      name: "zenx_projects_list",
      description:
        "List bounded workspace groupings derived from ZenX configuration and Thread cwd metadata. Projects are not runtime objects.",
      inputSchema: boundedListSchema(),
      permissions: [ZENX_SELF_CONTROL_WORKSPACE_PERMISSION],
      interactionMode: "background_safe",
      capabilities: ["zenx.projects.read"],
      maxOutputBytes: 512 * 1024,
    },
    {
      name: "zenx_threads_list",
      description:
        "List bounded App Server Threads, optionally filtered by workspace/cwd or a name, preview, and ID query.",
      inputSchema: {
        type: "object",
        properties: {
          workspace: { type: "string" },
          cwd: { type: "string" },
          query: { type: "string" },
          archived: { type: "boolean" },
          cursor: {
            type: "string",
            description:
              "Continue the same filters; list changes invalidate the cursor explicitly.",
          },
          limit: { type: "integer", minimum: 1, maximum: MAX_LIST_LIMIT },
        },
        additionalProperties: false,
      },
      permissions: [ZENX_SELF_CONTROL_WORKSPACE_PERMISSION],
      interactionMode: "background_safe",
      capabilities: ["zenx.threads.read"],
      maxOutputBytes: 512 * 1024,
    },
    {
      name: "zenx_threads_create",
      description:
        "Create an idle Thread through App Server thread/start with an explicit cwd and optional runtime settings.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          project: {
            type: "string",
            description:
              "Exact configured Project name or workspace path; use projects_list to discover.",
          },
          model: { type: "string" },
          effort: { type: "string" },
          approvalPolicy: { type: "string", enum: ["on-request", "never"] },
          sandbox: { type: "string", enum: ["danger-full-access"] },
        },
        anyOf: [{ required: ["cwd"] }, { required: ["project"] }],
        additionalProperties: false,
      },
      permissions: [
        ZENX_SELF_CONTROL_WORKSPACE_PERMISSION,
        ZENX_SELF_CONTROL_LOCAL_DEVICE_PERMISSION,
      ],
      interactionMode: "background_safe",
      capabilities: ["zenx.threads.control"],
      maxOutputBytes: 512 * 1024,
    },
    {
      name: "zenx_threads_read",
      description:
        "Read original canonical history. Default: latest turns; cursor reads older pages. Choose items or agent_messages, optionally within turnId. Choose item plus itemId for complete canonical JSON chunks; concatenate content using nextCursor. Previews are excerpts, never summaries.",
      inputSchema: {
        type: "object",
        properties: {
          ...targetProperties(),
          granularity: {
            type: "string",
            enum: ["turns", "items", "agent_messages", "item"],
          },
          turnId: { type: "string" },
          itemId: { type: "string" },
          cursor: { type: "string" },
          maxTurns: { type: "integer", minimum: 1, maximum: MAX_READ_TURNS },
          maxItemsPerTurn: {
            type: "integer",
            minimum: 1,
            maximum: MAX_READ_ITEMS,
          },
        },
        required: ["target"],
        additionalProperties: false,
      },
      permissions: [ZENX_SELF_CONTROL_WORKSPACE_PERMISSION],
      interactionMode: "background_safe",
      capabilities: ["zenx.threads.read"],
      maxOutputBytes: 512 * 1024,
    },
    {
      name: "zenx_threads_status",
      description:
        "Inspect authoritative idle, active, or error status and the current/last Turn identity for one Thread.",
      inputSchema: {
        type: "object",
        properties: targetProperties(),
        required: ["target"],
        additionalProperties: false,
      },
      permissions: [ZENX_SELF_CONTROL_WORKSPACE_PERMISSION],
      interactionMode: "background_safe",
      capabilities: ["zenx.threads.read"],
      maxOutputBytes: 512 * 1024,
    },
    {
      name: "zenx_threads_rename",
      description:
        "Set the authoritative user-facing name for a Thread through App Server thread/name/set.",
      inputSchema: {
        type: "object",
        properties: {
          ...targetProperties(),
          name: { type: "string" },
        },
        required: ["target", "name"],
        additionalProperties: false,
      },
      permissions: [
        ZENX_SELF_CONTROL_WORKSPACE_PERMISSION,
        ZENX_SELF_CONTROL_LOCAL_DEVICE_PERMISSION,
      ],
      interactionMode: "background_safe",
      capabilities: ["zenx.threads.control"],
      maxOutputBytes: 512 * 1024,
    },
    {
      name: "zenx_threads_archive",
      description:
        "Archive a Thread through the standard App Server lifecycle without changing its canonical history.",
      inputSchema: threadIdSchema(),
      permissions: [
        ZENX_SELF_CONTROL_WORKSPACE_PERMISSION,
        ZENX_SELF_CONTROL_LOCAL_DEVICE_PERMISSION,
      ],
      interactionMode: "background_safe",
      capabilities: ["zenx.threads.control"],
      maxOutputBytes: 512 * 1024,
    },
    {
      name: "zenx_threads_unarchive",
      description:
        "Restore an archived Thread to normal listings through the standard App Server lifecycle.",
      inputSchema: threadIdSchema(),
      permissions: [
        ZENX_SELF_CONTROL_WORKSPACE_PERMISSION,
        ZENX_SELF_CONTROL_LOCAL_DEVICE_PERMISSION,
      ],
      interactionMode: "background_safe",
      capabilities: ["zenx.threads.control"],
      maxOutputBytes: 512 * 1024,
    },
    {
      name: "zenx_threads_send",
      description:
        "Send a message to a Thread. Omit messageType to follow the saved ZenX sending preference; use follow_up to queue next work, guidance to supplement current work, or replacement to interrupt and change the task. The application handles message IDs and concurrent Turn checks.",
      inputSchema: {
        type: "object",
        properties: {
          ...targetProperties(),
          messageType: {
            type: "string",
            enum: ["follow_up", "guidance", "replacement"],
            description:
              "follow_up: do this after current work; guidance: add guidance to current work; replacement: interrupt current work and do this instead. Omit to use the saved ZenX send preference.",
          },
          text: { type: "string" },
        },
        required: ["target", "text"],
        additionalProperties: false,
      },
      permissions: [
        ZENX_SELF_CONTROL_WORKSPACE_PERMISSION,
        ZENX_SELF_CONTROL_LOCAL_DEVICE_PERMISSION,
      ],
      interactionMode: "background_safe",
      capabilities: ["zenx.threads.control"],
      maxOutputBytes: 512 * 1024,
    },
    {
      name: "zenx_self_control_workflows_get",
      description:
        "Read the user-scoped custom Slash workflows and title-generation prompt configured in ZenX Settings.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      permissions: [ZENX_SELF_CONTROL_WORKSPACE_PERMISSION],
      interactionMode: "background_safe",
      capabilities: ["zenx.projects.read"],
      maxOutputBytes: 512 * 1024,
    },
    {
      name: "zenx_self_control_workflows_update",
      description:
        "Replace the user-scoped custom Slash workflows and optional title prompt using the baseRevision from workflows_get. The built-in /compact command is reserved; omit titlePrompt or pass null to restore the default.",
      inputSchema: {
        type: "object",
        properties: {
          baseRevision: { type: "integer", minimum: 0 },
          commands: {
            type: "array",
            maxItems: 64,
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                description: { type: "string" },
                prompt: { type: "string" },
                enabled: { type: "boolean" },
              },
              required: ["name", "description", "prompt", "enabled"],
              additionalProperties: false,
            },
          },
          titlePrompt: { type: ["string", "null"] },
        },
        required: ["baseRevision", "commands"],
        additionalProperties: false,
      },
      permissions: [ZENX_SELF_CONTROL_LOCAL_DEVICE_PERMISSION],
      interactionMode: "background_safe",
      capabilities: ["zenx.threads.control"],
      maxOutputBytes: 512 * 1024,
    },
  ],
};
const controlToolNames = new Set(manifest.tools.map((tool) => tool.name));

export class ZenXSelfControlCapabilityPackage implements ZenXCapabilityPackage {
  readonly manifest = manifest;
  readonly #appServer: AppServerRequestPort;
  readonly #workflows: WorkflowConfigurationPort | undefined;
  readonly #sendPreference: () => Promise<"queue" | "soft" | "hard">;
  readonly #sending = new Map<
    string,
    { args: string; result: Promise<unknown> }
  >();

  constructor(options: {
    appServer: AppServerRequestPort;
    workflows?: WorkflowConfigurationPort;
    sendPreference?: () => Promise<"queue" | "soft" | "hard">;
  }) {
    this.#appServer = options.appServer;
    this.#workflows = options.workflows;
    this.#sendPreference = options.sendPreference ?? (async () => "queue");
  }

  async invoke(name: string, invocation: ToolInvocation): Promise<unknown> {
    if (name !== invocation.name || !controlToolNames.has(name)) {
      throw new Error(`Unsupported ZenX self-control tool: ${name}`);
    }
    invocation.signal.throwIfAborted();
    if (name === "zenx_threads_send") {
      const key = messageIdentity(invocation);
      const args = JSON.stringify(invocation.arguments);
      const pending = this.#sending.get(key);
      if (pending !== undefined) {
        if (pending.args !== args)
          throw new Error(
            "Tool invocation was already used for different input",
          );
        return await waitForAbort(pending.result, invocation.signal);
      }
      const result = this.#executeControl(
        name,
        invocation.arguments,
        invocation,
      );
      this.#sending.set(key, { args, result });
      try {
        return await result;
      } finally {
        this.#sending.delete(key);
      }
    }
    return await waitForAbort(
      this.#executeControl(name, invocation.arguments, invocation),
      invocation.signal,
    );
  }

  async #executeControl(
    name: string,
    args: Record<string, unknown>,
    invocation: ToolInvocation,
  ): Promise<unknown> {
    if (
      [
        "zenx_threads_read",
        "zenx_threads_status",
        "zenx_threads_rename",
        "zenx_threads_archive",
        "zenx_threads_unarchive",
        "zenx_threads_send",
        "zenx_threads_configure",
      ].includes(name)
    ) {
      if (args.target !== undefined && args.threadId !== undefined)
        throw new Error("Specify only target");
      const resolution = await resolveThreadTarget(this.#appServer, {
        target: requiredString(args.target ?? args.threadId, "target"),
        ...(args.workspace === undefined
          ? {}
          : { workspace: requiredString(args.workspace, "workspace") }),
      });
      if (resolution.status !== "resolved")
        return { source: SOURCE, ...resolution };
      const { target: _target, workspace: _workspace, ...rest } = args;
      args = { ...rest, threadId: resolution.threadId };
    }
    invocation.signal.throwIfAborted();
    switch (name) {
      case "zenx_models_list":
        assertOnly(args, []);
        return {
          source: SOURCE,
          models: (await this.#appServer.request("model/list", {})).data,
        };
      case "zenx_threads_configure": {
        assertOnly(args, ["threadId", "model", "effort"]);
        const threadId = requiredString(args.threadId, "threadId");
        const model = requiredString(args.model, "model");
        const effort = optionalString(args.effort, "effort");
        await this.#appServer.request("thread/settings/update", {
          threadId,
          model,
          ...(effort === undefined ? {} : { effort }),
        });
        const thread = (
          await this.#appServer.request("zen/thread/read", { threadId })
        ).thread;
        return {
          source: SOURCE,
          threadId,
          model: thread.modelId,
          modelProvider: thread.providerProfileId,
          reasoningEffort: thread.reasoningEffort,
          cwd: thread.cwd,
        };
      }
      case "zenx_projects_list":
        return await this.#listProjects(args);
      case "zenx_threads_list":
        return await this.#listThreads(args);
      case "zenx_threads_create":
        return await this.#createThread(args);
      case "zenx_threads_read":
        return await this.#readThread(args);
      case "zenx_threads_status":
        return await this.#threadStatus(args);
      case "zenx_threads_rename":
        return await this.#renameThread(args);
      case "zenx_threads_archive":
        return await this.#setArchived(args, true);
      case "zenx_threads_unarchive":
        return await this.#setArchived(args, false);
      case "zenx_threads_send":
        return await this.#send(args, invocation);
      case "zenx_self_control_workflows_get":
        assertOnly(args, []);
        return await this.#requireWorkflows().workflowConfiguration();
      case "zenx_self_control_workflows_update":
        return await this.#updateWorkflows(args);
      default:
        throw new Error(`Unsupported ZenX product tool: ${name}`);
    }
  }

  #requireWorkflows(): WorkflowConfigurationPort {
    if (this.#workflows === undefined)
      throw new Error("ZenX workflow configuration is not attached");
    return this.#workflows;
  }

  async #updateWorkflows(args: Record<string, unknown>): Promise<unknown> {
    assertOnly(args, ["baseRevision", "commands", "titlePrompt"]);
    await this.#requireWorkflows().saveWorkflowConfiguration({
      baseRevision: nonNegativeInteger(args.baseRevision, "baseRevision"),
      commands: args.commands as WorkflowCommand[],
      ...(args.titlePrompt === undefined || args.titlePrompt === null
        ? {}
        : {
            titlePrompt: limitedString(args.titlePrompt, "titlePrompt", 32_768),
          }),
    });
    return await this.#requireWorkflows().workflowConfiguration();
  }

  async #listProjects(args: Record<string, unknown>): Promise<unknown> {
    assertOnly(args, ["limit"]);
    const limit = boundedInteger(
      args.limit,
      "limit",
      DEFAULT_LIST_LIMIT,
      MAX_LIST_LIMIT,
    );
    const threads = (await this.#appServer.request("thread/list", {})).data;
    const snapshot = await this.#appServer.projectProjection.project(
      threads.map((thread) => ({
        id: thread.id,
        cwd: thread.status.type === "systemError" ? null : thread.cwd,
      })),
    );
    const all = snapshot.projects.map((project) => ({
      name: project.name ?? path.basename(project.workspace),
      workspace: project.workspace,
      cwd: project.workspace,
      configured: project.configured,
      isDefault: project.isDefault,
      threadCount: project.threadIds.length,
      threadIds: project.threadIds.slice(0, MAX_LIST_LIMIT),
      threadIdsTruncated: project.threadIds.length > MAX_LIST_LIMIT,
    }));
    return {
      source: SOURCE,
      derivation: "ZenX host workspaces plus App Server Thread cwd",
      projects: all.slice(0, limit),
      truncated: all.length > limit,
    };
  }

  async #listThreads(args: Record<string, unknown>): Promise<unknown> {
    assertOnly(args, [
      "workspace",
      "cwd",
      "query",
      "archived",
      "limit",
      "cursor",
    ]);
    const workspace = optionalString(args.workspace, "workspace");
    const cwd = optionalString(args.cwd, "cwd");
    const cwdFilter = workspace ?? cwd;
    const query = optionalString(args.query, "query")?.toLocaleLowerCase();
    const archived = optionalBoolean(args.archived, "archived") ?? false;
    const limit = boundedInteger(
      args.limit,
      "limit",
      DEFAULT_LIST_LIMIT,
      MAX_LIST_LIMIT,
    );
    const listed = (await this.#appServer.request("thread/list", { archived }))
      .data;
    let filtered = listed;
    if (cwdFilter !== undefined) {
      const filterPaths = [
        ...(workspace === undefined ? [] : [workspace]),
        ...(cwd === undefined ? [] : [cwd]),
      ];
      const threadsWithCwd = listed.filter((thread) => thread.cwd.length > 0);
      const keys = await this.#appServer.projectProjection.canonicalKeys([
        ...filterPaths,
        ...threadsWithCwd.map((thread) => thread.cwd),
      ]);
      const workspaceKey = workspace === undefined ? undefined : keys[0];
      const cwdKey =
        cwd === undefined ? undefined : keys[workspace === undefined ? 0 : 1];
      if (
        workspaceKey !== undefined &&
        cwdKey !== undefined &&
        workspaceKey !== cwdKey
      ) {
        throw new Error(
          "workspace and cwd filters must identify the same path",
        );
      }
      const filterKey = workspaceKey ?? cwdKey;
      const threadOffset = filterPaths.length;
      const matchingIds = new Set(
        threadsWithCwd
          .filter((_thread, index) => keys[threadOffset + index] === filterKey)
          .map((thread) => thread.id),
      );
      filtered = listed.filter((thread) => matchingIds.has(thread.id));
    }
    const threads = filtered
      .filter((thread) => query === undefined || matchesQuery(thread, query))
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const other = (
      await this.#appServer.request("thread/list", { archived: !archived })
    ).data;
    const identities = [...listed, ...other];
    const binding = createHash("sha256")
      .update(
        JSON.stringify([
          workspace ?? null,
          cwd ?? null,
          query ?? null,
          archived,
          threads.map((thread) => thread.id),
        ]),
      )
      .digest("hex");
    let offset = 0;
    if (args.cursor !== undefined) {
      try {
        const value = JSON.parse(
          Buffer.from(
            requiredString(args.cursor, "cursor"),
            "base64url",
          ).toString("utf8"),
        ) as { binding: string; offset: number };
        if (
          value.binding !== binding ||
          !Number.isSafeInteger(value.offset) ||
          value.offset < 0 ||
          value.offset > threads.length
        )
          throw new Error();
        offset = value.offset;
      } catch {
        throw new Error(
          "Invalid list cursor: filters or Thread listing changed",
        );
      }
    }
    const end = Math.min(threads.length, offset + limit);
    return {
      source: SOURCE,
      threads: threads.slice(offset, end).map((thread) => {
        let length = Math.min(8, thread.id.length);
        while (
          length < thread.id.length &&
          identities.some(
            (other) =>
              other.id !== thread.id &&
              (other.id.startsWith(thread.id.slice(0, length)) ||
                other.name === thread.id.slice(0, length)),
          )
        )
          length++;
        return {
          ...projectThreadSummary(thread, archived),
          shortId: thread.id.slice(0, length),
        };
      }),
      truncated: end < threads.length,
      nextCursor:
        end < threads.length
          ? Buffer.from(JSON.stringify({ binding, offset: end })).toString(
              "base64url",
            )
          : null,
    };
  }

  async #createThread(args: Record<string, unknown>): Promise<unknown> {
    assertOnly(args, [
      "cwd",
      "project",
      "model",
      "effort",
      "approvalPolicy",
      "sandbox",
    ]);
    if (args.cwd !== undefined && args.project !== undefined)
      throw new Error("Specify project or cwd, not both");
    let requestedCwd: string;
    if (args.project !== undefined) {
      const project = requiredString(args.project, "project");
      const snapshot = await this.#appServer.projectProjection.project([]);
      const pathMatch =
        await this.#appServer.projectProjection.configuredWorkspace(project);
      const matches =
        pathMatch === null
          ? snapshot.projects.filter(
              (entry) =>
                (entry.name ?? path.basename(entry.workspace)) === project,
            )
          : snapshot.projects.filter((entry) => entry.workspace === pathMatch);
      if (matches.length !== 1)
        return {
          source: SOURCE,
          status: matches.length === 0 ? "not_found" : "ambiguous",
          candidates: matches.map((entry) => ({
            name: entry.name ?? path.basename(entry.workspace),
            cwd: entry.workspace,
          })),
        };
      requestedCwd = matches[0]!.workspace;
    } else requestedCwd = path.resolve(requiredString(args.cwd, "cwd"));
    const cwd =
      await this.#appServer.projectProjection.configuredWorkspace(requestedCwd);
    if (cwd === null)
      throw new Error("Configure the workspace as a ZenX Project first");
    const model = optionalString(args.model, "model");
    const effort = optionalString(args.effort, "effort");
    const approvalPolicy = optionalEnum(args.approvalPolicy, "approvalPolicy", [
      "on-request",
      "never",
    ] as const);
    const sandbox = optionalEnum(args.sandbox, "sandbox", [
      "danger-full-access",
    ] as const);
    const result = await this.#appServer.request("thread/start", {
      cwd,
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
      ...(sandbox === undefined ? {} : { sandbox }),
    });
    return {
      source: SOURCE,
      threadId: result.thread.id,
      thread: projectThreadSummary(result.thread),
      runtime: {
        cwd: result.cwd,
        model: result.model,
        modelProvider: result.modelProvider,
        reasoningEffort: result.reasoningEffort,
        approvalPolicy: result.approvalPolicy,
        sandbox: result.sandbox.type,
      },
    };
  }

  async #readThread(args: Record<string, unknown>): Promise<unknown> {
    assertOnly(args, [
      "threadId",
      "maxTurns",
      "maxItemsPerTurn",
      "granularity",
      "turnId",
      "itemId",
      "cursor",
    ]);
    const threadId = requiredString(args.threadId, "threadId");
    const granularity =
      optionalEnum(args.granularity, "granularity", [
        "turns",
        "items",
        "agent_messages",
        "item",
      ] as const) ?? "turns";
    const turnId = optionalString(args.turnId, "turnId");
    const itemId = optionalString(args.itemId, "itemId");
    if (granularity === "item" && itemId === undefined)
      throw new Error("itemId is required for item reads");
    if (granularity !== "item" && itemId !== undefined)
      throw new Error("itemId requires item granularity");
    if (granularity === "turns" && turnId !== undefined)
      throw new Error(
        "turnId requires items, agent_messages or item granularity",
      );
    const cursor = optionalString(args.cursor, "cursor");
    const thread = (
      await this.#appServer.request("zen/thread/read", { threadId })
    ).thread;
    return readThreadHistory(thread, {
      granularity,
      ...(turnId === undefined ? {} : { turnId }),
      ...(itemId === undefined ? {} : { itemId }),
      ...(cursor === undefined ? {} : { cursor }),
      maxTurns: boundedInteger(
        args.maxTurns,
        "maxTurns",
        DEFAULT_READ_TURNS,
        MAX_READ_TURNS,
      ),
      maxItemsPerTurn: boundedInteger(
        args.maxItemsPerTurn,
        "maxItemsPerTurn",
        DEFAULT_READ_ITEMS,
        MAX_READ_ITEMS,
      ),
    });
  }

  async #threadStatus(args: Record<string, unknown>): Promise<unknown> {
    assertOnly(args, ["threadId"]);
    const requestedThreadId = requiredString(args.threadId, "threadId");
    const thread = (
      await this.#appServer.request("thread/read", {
        threadId: requestedThreadId,
        includeTurns: true,
      })
    ).thread;
    const active = [...thread.turns]
      .reverse()
      .find((turn) => turn.status === "inProgress");
    const last = thread.turns.at(-1);
    return {
      source: SOURCE,
      threadId: thread.id,
      cwd: thread.cwd,
      status: statusType(thread),
      activeTurnId: active?.id ?? null,
      lastTurn:
        last === undefined
          ? null
          : {
              turnId: last.id,
              status: last.status,
              error: last.error?.message ?? null,
            },
      updatedAt: thread.updatedAt,
    };
  }

  async #renameThread(args: Record<string, unknown>): Promise<unknown> {
    assertOnly(args, ["threadId", "name"]);
    const threadId = requiredString(args.threadId, "threadId");
    await this.#appServer.request("thread/name/set", {
      threadId,
      name: requiredString(args.name, "name"),
    });
    const thread = (await this.#appServer.request("thread/read", { threadId }))
      .thread;
    return { source: SOURCE, threadId, name: thread.name };
  }

  async #setArchived(
    args: Record<string, unknown>,
    archived: boolean,
  ): Promise<unknown> {
    assertOnly(args, ["threadId"]);
    const threadId = requiredString(args.threadId, "threadId");
    if (archived) {
      await this.#appServer.request("thread/archive", { threadId });
    } else {
      await this.#appServer.request("thread/unarchive", { threadId });
    }
    return { source: SOURCE, threadId, archived };
  }

  async #send(
    args: Record<string, unknown>,
    invocation: ToolInvocation,
  ): Promise<unknown> {
    assertOnly(args, ["threadId", "text", "messageType"]);
    const threadId = requiredString(args.threadId, "threadId");
    const text = limitedString(args.text, "text", MAX_SEND_TEXT_LENGTH);
    const messageType = optionalEnum(args.messageType, "messageType", [
      "follow_up",
      "guidance",
      "replacement",
    ] as const);
    const clientUserMessageId = messageIdentity(invocation);
    const thread = (
      await this.#appServer.request("zen/thread/read", { threadId })
    ).thread;
    const previous = thread.items.find(
      (item) =>
        (item.type === "user_message" ||
          item.type === "user_message_queued" ||
          item.type === "turn_replacement_requested") &&
        item.clientId === clientUserMessageId,
    );
    if (
      previous !== undefined &&
      (previous.type === "user_message" ||
        previous.type === "user_message_queued" ||
        previous.type === "turn_replacement_requested")
    ) {
      const priorText =
        "input" in previous && previous.input !== undefined
          ? textFromUserInput(previous.input)
          : "content" in previous && previous.content !== undefined
            ? textFromUserInput(previous.content)
            : "text" in previous
              ? previous.text
              : undefined;
      if (priorText !== text)
        throw new Error("Tool invocation was already used for different input");
      if (previous.type === "turn_replacement_requested") {
        // Reuse the original canonical fence, including an interrupted replacement
        // whose successor has not yet been accepted. The server owns that retry.
        invocation.signal.throwIfAborted();
        const result = await this.#appServer.request("turn/replace", {
          threadId,
          expectedTurnId: previous.turnId,
          clientUserMessageId,
          input: [{ type: "text", text }],
        });
        return {
          source: SOURCE,
          threadId,
          clientUserMessageId,
          duplicate: true,
          mode: "replace",
          ...result,
        };
      }
      const delivered = thread.items.find(
        (item) =>
          item.type === "user_message" && item.clientId === clientUserMessageId,
      );
      return {
        source: SOURCE,
        threadId,
        clientUserMessageId,
        duplicate: true,
        turnId: delivered?.turnId ?? null,
        queued:
          previous.type === "user_message_queued" && delivered === undefined,
      };
    }
    const active = thread.turns.find((turn) => turn.status === "inProgress");
    const preference =
      messageType === "follow_up"
        ? "queue"
        : messageType === "guidance"
          ? "soft"
          : messageType === "replacement"
            ? "hard"
            : await this.#sendPreference();
    invocation.signal.throwIfAborted();
    const input = [{ type: "text" as const, text }];
    if (active === undefined) {
      const result = await this.#appServer.request("turn/start", {
        threadId,
        input,
        clientUserMessageId,
      });
      return {
        source: SOURCE,
        threadId,
        mode: "start",
        clientUserMessageId,
        turnId: result.turn.id,
      };
    }
    if (preference === "queue") {
      await this.#appServer.request("turn/queue", {
        threadId,
        input,
        clientUserMessageId,
      });
      return {
        source: SOURCE,
        threadId,
        mode: "queue",
        clientUserMessageId,
        turnId: null,
        queued: true,
      };
    }
    const expectedTurnId = active.id;
    if (preference === "soft") {
      const result = await this.#appServer.request("turn/steer", {
        threadId,
        input,
        clientUserMessageId,
        expectedTurnId,
      });
      return {
        source: SOURCE,
        threadId,
        mode: "steer",
        clientUserMessageId,
        expectedTurnId,
        turnId: result.turnId,
      };
    }
    const result = await this.#appServer.request("turn/replace", {
      threadId,
      input,
      clientUserMessageId,
      expectedTurnId,
    });
    return {
      source: SOURCE,
      threadId,
      mode: "replace",
      clientUserMessageId,
      expectedTurnId,
      ...result,
    };
  }
}

function boundedListSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: MAX_LIST_LIMIT },
    },
    additionalProperties: false,
  };
}

function projectThreadSummary(
  thread: Thread,
  archived = false,
): Record<string, unknown> {
  return {
    threadId: thread.id,
    cwd: thread.cwd,
    name: thread.name,
    preview: clip(thread.preview),
    status: statusType(thread),
    archived,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

function threadIdSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: targetProperties(),
    required: ["target"],
    additionalProperties: false,
  };
}

function statusType(thread: Thread): "idle" | "active" | "systemError" {
  return thread.status.type;
}

function matchesQuery(thread: Thread, query: string): boolean {
  return [thread.id, thread.name ?? "", thread.preview].some((value) =>
    value.toLocaleLowerCase().includes(query),
  );
}

function clip(value: string): string {
  return value.length <= MAX_TEXT_LENGTH
    ? value
    : `${value.slice(0, MAX_TEXT_LENGTH)}…[truncated]`;
}

function assertOnly(args: Record<string, unknown>, keys: string[]): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(args).find((key) => !allowed.has(key));
  if (unexpected !== undefined) {
    throw new Error(`Unexpected argument: ${unexpected}`);
  }
}

function requiredString(value: unknown, label: string): string {
  return limitedString(value, label, 4_096);
}

function limitedString(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    throw new Error(`${label} exceeds ${String(maxLength)} characters`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  label: string,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximum
  ) {
    throw new Error(`${label} must be an integer from 1 to ${String(maximum)}`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`${label} must be a non-negative integer`);
  return value as number;
}

function requiredEnum<const T extends readonly string[]>(
  value: unknown,
  label: string,
  values: T,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${label} must be one of: ${values.join(", ")}`);
  }
  return value;
}

function optionalEnum<const T extends readonly string[]>(
  value: unknown,
  label: string,
  values: T,
): T[number] | undefined {
  return value === undefined ? undefined : requiredEnum(value, label, values);
}

async function waitForAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const aborted = (): void => {
      cleanup();
      reject(
        signal.reason ??
          new DOMException("The operation was aborted", "AbortError"),
      );
    };
    const cleanup = (): void => signal.removeEventListener("abort", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    void operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function messageIdentity(invocation: ToolInvocation): string {
  return `zenx-self-control:${createHash("sha256")
    .update(
      JSON.stringify([
        invocation.threadId ?? invocation.cwd,
        invocation.canonicalToolCallId ?? invocation.callId,
      ]),
    )
    .digest("hex")}`;
}

function targetProperties(): Record<string, unknown> {
  return {
    target: {
      type: "string",
      description:
        "Full Thread ID, unique ID prefix, or exact title. Ambiguous targets return candidates without writing.",
    },
    workspace: {
      type: "string",
      description: "Optional workspace path to disambiguate the target.",
    },
  };
}
