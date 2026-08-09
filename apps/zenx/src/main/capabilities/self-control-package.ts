import path from "node:path";

import type { ToolInvocation } from "../../../../../src/tool.js";
import type {
  ClientRequestMethod,
  ClientRequestParams,
  ClientRequestResults,
  Thread,
  ThreadItem,
} from "../../protocol-client/index.js";
import type { ZenXCapabilityManifest, ZenXCapabilityPackage } from "./types.js";

export const ZENX_SELF_CONTROL_CAPABILITY_ID = "zenx-self-control";
export const ZENX_SELF_CONTROL_WORKSPACE_PERMISSION =
  "zenx-self-control.workspace-read";
export const ZENX_SELF_CONTROL_LOCAL_DEVICE_PERMISSION =
  "zenx-self-control.local-device-control";

type SelfControlRequestMethod = Extract<
  ClientRequestMethod,
  | "thread/list"
  | "thread/start"
  | "thread/read"
  | "turn/start"
  | "turn/steer"
  | "turn/replace"
>;

export interface AppServerRequestPort {
  readonly configuredWorkspace: string;
  request<M extends SelfControlRequestMethod>(
    method: M,
    params: ClientRequestParams[M],
  ): Promise<ClientRequestResults[M]>;
}

interface AppServerRequestTarget {
  request<M extends SelfControlRequestMethod>(
    method: M,
    params: ClientRequestParams[M],
  ): Promise<ClientRequestResults[M]>;
}

export class MutableAppServerRequestPort implements AppServerRequestPort {
  #target: AppServerRequestTarget | undefined;
  #configuredWorkspace: string | undefined;

  get configuredWorkspace(): string {
    if (this.#configuredWorkspace === undefined) {
      throw new Error("ZenX self-control App Server port is not attached");
    }
    return this.#configuredWorkspace;
  }

  attach(target: AppServerRequestTarget, configuredWorkspace: string): void {
    this.#target = target;
    this.#configuredWorkspace = path.resolve(configuredWorkspace);
  }

  detach(target?: AppServerRequestTarget): void {
    if (target !== undefined && target !== this.#target) return;
    this.#target = undefined;
    this.#configuredWorkspace = undefined;
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

const manifest: ZenXCapabilityManifest = {
  schemaVersion: 1,
  id: ZENX_SELF_CONTROL_CAPABILITY_ID,
  displayName: "ZenX self-control",
  version: "1.0.0",
  description:
    "List derived workspaces and control Zen Threads through typed App Server requests.",
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
        "Create local Threads and start, steer, or replace their active Turns through App Server.",
      scope: "local-device",
    },
  ],
  tools: [
    {
      name: "zenx_projects_list",
      description:
        "List bounded workspace groupings derived from ZenX configuration and Thread cwd metadata. Projects are not runtime objects.",
      inputSchema: boundedListSchema(),
      permissions: [ZENX_SELF_CONTROL_WORKSPACE_PERMISSION],
      interactionMode: "background_safe",
      capabilities: ["zenx.projects.read"],
      maxOutputBytes: 64 * 1024,
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
          limit: { type: "integer", minimum: 1, maximum: MAX_LIST_LIMIT },
        },
        additionalProperties: false,
      },
      permissions: [ZENX_SELF_CONTROL_WORKSPACE_PERMISSION],
      interactionMode: "background_safe",
      capabilities: ["zenx.threads.read"],
      maxOutputBytes: 64 * 1024,
    },
    {
      name: "zenx_threads_create",
      description:
        "Create an idle Thread through App Server thread/start with an explicit cwd and optional runtime settings.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          model: { type: "string" },
          approvalPolicy: { type: "string", enum: ["on-request", "never"] },
          sandbox: { type: "string", enum: ["danger-full-access"] },
        },
        required: ["cwd"],
        additionalProperties: false,
      },
      permissions: [
        ZENX_SELF_CONTROL_WORKSPACE_PERMISSION,
        ZENX_SELF_CONTROL_LOCAL_DEVICE_PERMISSION,
      ],
      interactionMode: "background_safe",
      capabilities: ["zenx.threads.control"],
      maxOutputBytes: 64 * 1024,
    },
    {
      name: "zenx_threads_read",
      description:
        "Read bounded recent turns and safe item projections from one Thread through App Server thread/read.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string" },
          maxTurns: { type: "integer", minimum: 1, maximum: MAX_READ_TURNS },
          maxItemsPerTurn: {
            type: "integer",
            minimum: 1,
            maximum: MAX_READ_ITEMS,
          },
        },
        required: ["threadId"],
        additionalProperties: false,
      },
      permissions: [ZENX_SELF_CONTROL_WORKSPACE_PERMISSION],
      interactionMode: "background_safe",
      capabilities: ["zenx.threads.read"],
      maxOutputBytes: 64 * 1024,
    },
    {
      name: "zenx_threads_status",
      description:
        "Inspect authoritative idle, active, or error status and the current/last Turn identity for one Thread.",
      inputSchema: {
        type: "object",
        properties: { threadId: { type: "string" } },
        required: ["threadId"],
        additionalProperties: false,
      },
      permissions: [ZENX_SELF_CONTROL_WORKSPACE_PERMISSION],
      interactionMode: "background_safe",
      capabilities: ["zenx.threads.read"],
      maxOutputBytes: 64 * 1024,
    },
    {
      name: "zenx_threads_send",
      description:
        "Send input through explicit App Server start, steer, or replace semantics. steer and replace require the expected active Turn ID; every mode requires a stable clientUserMessageId.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string" },
          mode: { type: "string", enum: ["start", "steer", "replace"] },
          text: { type: "string" },
          expectedTurnId: { type: "string" },
          clientUserMessageId: { type: "string" },
        },
        required: ["threadId", "mode", "text", "clientUserMessageId"],
        additionalProperties: false,
      },
      permissions: [
        ZENX_SELF_CONTROL_WORKSPACE_PERMISSION,
        ZENX_SELF_CONTROL_LOCAL_DEVICE_PERMISSION,
      ],
      interactionMode: "background_safe",
      capabilities: ["zenx.threads.control"],
      maxOutputBytes: 64 * 1024,
    },
  ],
  resources: [],
};
const controlToolNames = new Set(manifest.tools.map((tool) => tool.name));

export class ZenXSelfControlCapabilityPackage implements ZenXCapabilityPackage {
  readonly manifest = manifest;
  readonly #appServer: AppServerRequestPort;

  constructor(options: { appServer: AppServerRequestPort }) {
    this.#appServer = options.appServer;
  }

  async invoke(name: string, invocation: ToolInvocation): Promise<unknown> {
    if (name !== invocation.name || !controlToolNames.has(name)) {
      throw new Error(`Unsupported ZenX self-control tool: ${name}`);
    }
    invocation.signal.throwIfAborted();
    return await waitForAbort(
      this.#executeControl(name, invocation.arguments),
      invocation.signal,
    );
  }

  async #executeControl(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    switch (name) {
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
      case "zenx_threads_send":
        return await this.#send(args);
      default:
        throw new Error(`Unsupported ZenX product tool: ${name}`);
    }
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
    const projects = new Map<
      string,
      { cwd: string; configured: boolean; threadIds: string[] }
    >();
    const configuredWorkspace = this.#appServer.configuredWorkspace;
    projects.set(configuredWorkspace, {
      cwd: configuredWorkspace,
      configured: true,
      threadIds: [],
    });
    for (const thread of threads) {
      if (thread.cwd.length === 0) continue;
      const cwd = path.resolve(thread.cwd);
      const project = projects.get(cwd) ?? {
        cwd,
        configured: cwd === configuredWorkspace,
        threadIds: [],
      };
      project.threadIds.push(thread.id);
      projects.set(cwd, project);
    }
    const all = [...projects.values()]
      .sort((left, right) => left.cwd.localeCompare(right.cwd))
      .map((project) => ({
        workspace: project.cwd,
        cwd: project.cwd,
        configured: project.configured,
        threadCount: project.threadIds.length,
        threadIds: project.threadIds.slice(0, MAX_LIST_LIMIT),
        threadIdsTruncated: project.threadIds.length > MAX_LIST_LIMIT,
      }));
    return {
      source: SOURCE,
      derivation: "configured workspace plus App Server Thread cwd",
      projects: all.slice(0, limit),
      truncated: all.length > limit,
    };
  }

  async #listThreads(args: Record<string, unknown>): Promise<unknown> {
    assertOnly(args, ["workspace", "cwd", "query", "limit"]);
    const workspace = optionalString(args.workspace, "workspace");
    const cwd = optionalString(args.cwd, "cwd");
    if (workspace !== undefined && cwd !== undefined) {
      if (path.resolve(workspace) !== path.resolve(cwd)) {
        throw new Error(
          "workspace and cwd filters must identify the same path",
        );
      }
    }
    const cwdFilter = workspace ?? cwd;
    const resolvedFilter =
      cwdFilter === undefined ? undefined : path.resolve(cwdFilter);
    const query = optionalString(args.query, "query")?.toLocaleLowerCase();
    const limit = boundedInteger(
      args.limit,
      "limit",
      DEFAULT_LIST_LIMIT,
      MAX_LIST_LIMIT,
    );
    const threads = (await this.#appServer.request("thread/list", {})).data
      .filter(
        (thread) =>
          resolvedFilter === undefined ||
          (thread.cwd.length > 0 &&
            path.resolve(thread.cwd) === resolvedFilter),
      )
      .filter((thread) => query === undefined || matchesQuery(thread, query))
      .sort((left, right) => right.updatedAt - left.updatedAt);
    return {
      source: SOURCE,
      threads: threads.slice(0, limit).map(projectThreadSummary),
      truncated: threads.length > limit,
    };
  }

  async #createThread(args: Record<string, unknown>): Promise<unknown> {
    assertOnly(args, ["cwd", "model", "approvalPolicy", "sandbox"]);
    const cwd = path.resolve(requiredString(args.cwd, "cwd"));
    const model = optionalString(args.model, "model");
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
        approvalPolicy: result.approvalPolicy,
        sandbox: result.sandbox.type,
      },
    };
  }

  async #readThread(args: Record<string, unknown>): Promise<unknown> {
    assertOnly(args, ["threadId", "maxTurns", "maxItemsPerTurn"]);
    const threadId = requiredString(args.threadId, "threadId");
    const maxTurns = boundedInteger(
      args.maxTurns,
      "maxTurns",
      DEFAULT_READ_TURNS,
      MAX_READ_TURNS,
    );
    const maxItems = boundedInteger(
      args.maxItemsPerTurn,
      "maxItemsPerTurn",
      DEFAULT_READ_ITEMS,
      MAX_READ_ITEMS,
    );
    const thread = (
      await this.#appServer.request("thread/read", {
        threadId,
        includeTurns: true,
      })
    ).thread;
    const recentTurns = thread.turns.slice(-maxTurns);
    return {
      source: SOURCE,
      threadId: thread.id,
      cwd: thread.cwd,
      status: statusType(thread),
      turns: recentTurns.map((turn) => ({
        turnId: turn.id,
        status: turn.status,
        error: turn.error?.message ?? null,
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        items: turn.items.slice(-maxItems).map(projectItem),
        itemsTruncated: turn.items.length > maxItems,
      })),
      turnsTruncated: thread.turns.length > maxTurns,
      bounds: {
        maxTurns,
        maxItemsPerTurn: maxItems,
        maxTextLength: MAX_TEXT_LENGTH,
      },
    };
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

  async #send(args: Record<string, unknown>): Promise<unknown> {
    assertOnly(args, [
      "threadId",
      "mode",
      "text",
      "expectedTurnId",
      "clientUserMessageId",
    ]);
    const threadId = requiredString(args.threadId, "threadId");
    const mode = requiredEnum(args.mode, "mode", [
      "start",
      "steer",
      "replace",
    ] as const);
    const text = limitedString(args.text, "text", MAX_SEND_TEXT_LENGTH);
    const clientUserMessageId = limitedString(
      args.clientUserMessageId,
      "clientUserMessageId",
      256,
    );
    const expectedTurnId = optionalString(
      args.expectedTurnId,
      "expectedTurnId",
    );
    if (mode === "start") {
      if (expectedTurnId !== undefined) {
        throw new Error("expectedTurnId is only valid for steer or replace");
      }
      const result = await this.#appServer.request("turn/start", {
        threadId,
        input: [{ type: "text", text }],
        clientUserMessageId,
      });
      return {
        source: SOURCE,
        threadId,
        mode,
        clientUserMessageId,
        turnId: result.turn.id,
      };
    }
    if (expectedTurnId === undefined) {
      throw new Error(`${mode} requires expectedTurnId`);
    }
    if (mode === "steer") {
      const result = await this.#appServer.request("turn/steer", {
        threadId,
        expectedTurnId,
        input: [{ type: "text", text }],
        clientUserMessageId,
      });
      return {
        source: SOURCE,
        threadId,
        mode,
        clientUserMessageId,
        expectedTurnId,
        turnId: result.turnId,
      };
    }
    const result = await this.#appServer.request("turn/replace", {
      threadId,
      expectedTurnId,
      input: [{ type: "text", text }],
      clientUserMessageId,
    });
    return {
      source: SOURCE,
      threadId,
      mode,
      clientUserMessageId,
      expectedTurnId,
      interruptedTurnId: result.interruptedTurnId,
      turnId: result.turnId,
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

function projectThreadSummary(thread: Thread): Record<string, unknown> {
  return {
    threadId: thread.id,
    cwd: thread.cwd,
    name: thread.name,
    preview: clip(thread.preview),
    status: statusType(thread),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

function projectItem(item: ThreadItem): Record<string, unknown> {
  switch (item.type) {
    case "userMessage":
      return {
        itemId: item.id,
        type: item.type,
        clientId: item.clientId,
        text: clip(item.content.map((entry) => entry.text).join("\n")),
      };
    case "agentMessage":
      return { itemId: item.id, type: item.type, text: clip(item.text) };
    case "reasoning":
      return {
        itemId: item.id,
        type: item.type,
        summary: clip(item.summary.join("\n")),
      };
    case "commandExecution":
      return {
        itemId: item.id,
        type: item.type,
        command: clip(item.command),
        cwd: item.cwd,
        status: item.status,
        exitCode: item.exitCode,
        outputOmitted: true,
      };
  }
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
