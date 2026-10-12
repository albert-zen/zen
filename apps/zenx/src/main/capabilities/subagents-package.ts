import type { ToolInvocation } from "../../../../../src/tool.js";
import type { NativeThreadSummary } from "../../../../../src/thread-summary.js";
import type { ZenXCapabilityPackage } from "./types.js";
import { subagentsManifest } from "../../../../../packages/zenx-subagents-plugin/src/manifest.js";
import {
  ZenXSelfControlCapabilityPackage,
  type AppServerRequestPort,
} from "./self-control-package.js";

export class ZenXSubagentsCapabilityPackage implements ZenXCapabilityPackage {
  readonly manifest = subagentsManifest;
  readonly #appServer: AppServerRequestPort;
  readonly #threads: ZenXSelfControlCapabilityPackage;
  readonly #listSummaries: () => Promise<NativeThreadSummary[]>;

  constructor(options: {
    appServer: AppServerRequestPort;
    threads: ZenXSelfControlCapabilityPackage;
    listSummaries(): Promise<NativeThreadSummary[]>;
  }) {
    this.#appServer = options.appServer;
    this.#threads = options.threads;
    this.#listSummaries = options.listSummaries;
  }

  async invoke(name: string, invocation: ToolInvocation): Promise<unknown> {
    if (
      name !== invocation.name ||
      !this.manifest.tools.some((tool) => tool.name === name)
    )
      throw new Error(`Unsupported Subagents tool: ${name}`);
    invocation.signal.throwIfAborted();
    // Product commands wrap their input. Model arguments cannot mint this marker.
    const args =
      invocation.trustedPluginUi === true &&
      invocation.arguments.input !== undefined
        ? record(invocation.arguments.input)
        : invocation.arguments;
    if (name === "zenx_subagents_send" || name === "zenx_subagents_read") {
      const mapped =
        name === "zenx_subagents_send"
          ? "zenx_threads_send"
          : "zenx_threads_read";
      return await this.#threads.invoke(mapped, {
        ...invocation,
        name: mapped,
        arguments: args,
      });
    }
    const allowed =
      name === "zenx_subagents_create"
        ? ["parentThreadId", "mode", "title", "task"]
        : ["parentThreadId"];
    for (const key of Object.keys(args)) {
      if (!allowed.includes(key))
        throw new Error(`Unexpected argument: ${key}`);
    }
    const parentThreadId = string(
      args.parentThreadId ?? invocation.threadId,
      "parentThreadId",
    );
    if (name === "zenx_subagents_list") {
      await this.#appServer.request("zen/thread/read", {
        threadId: parentThreadId,
      });
      const summaries = await this.#listSummaries();
      const descendants = new Set<string>();
      let changed = true;
      while (changed) {
        changed = false;
        for (const summary of summaries) {
          if (
            summary.status === "systemError" ||
            summary.threadId === parentThreadId ||
            descendants.has(summary.threadId)
          )
            continue;
          if (
            summary.parentThreadId === parentThreadId ||
            (summary.parentThreadId !== undefined &&
              descendants.has(summary.parentThreadId))
          ) {
            descendants.add(summary.threadId);
            changed = true;
          }
        }
      }
      return {
        threads: summaries.filter((summary) =>
          descendants.has(summary.threadId),
        ),
      };
    }
    const mode = args.mode;
    if (mode !== "fresh" && mode !== "fork" && mode !== "side-chat")
      throw new Error("mode must be fresh, fork, or side-chat");
    if (mode === "side-chat" && args.task !== undefined)
      throw new Error(
        "Side chat creation waits for an explicit user request; task is not allowed",
      );
    const title =
      args.title === undefined ? undefined : string(args.title, "title", 256);
    const task =
      args.task === undefined ? undefined : string(args.task, "task", 100000);
    const { thread } = await this.#appServer.request(
      "zen/thread/create-child",
      { parentThreadId, mode },
    );
    const summary = {
      id: thread.id,
      parentThreadId: thread.parentThreadId,
      cwd: thread.cwd,
      providerProfileId: thread.providerProfileId,
      modelId: thread.modelId,
      reasoningEffort: thread.reasoningEffort,
      sandbox: thread.sandbox,
      approvalPolicy: thread.approvalPolicy,
      name: thread.name,
      archived: thread.archived,
      status: thread.turns.some((turn) => turn.status === "inProgress")
        ? "active"
        : "idle",
    };
    // The native creation is durable even if an optional follow-up operation fails.
    let named = title === undefined;
    try {
      if (title !== undefined) {
        invocation.signal.throwIfAborted();
        await this.#appServer.request("thread/name/set", {
          threadId: thread.id,
          name: title,
        });
        named = true;
        summary.name = title;
      }
      if (task === undefined)
        return { threadId: thread.id, parentThreadId, thread: summary };
      invocation.signal.throwIfAborted();
      const delivery = await this.#threads.invoke("zenx_threads_send", {
        ...invocation,
        name: "zenx_threads_send",
        arguments: {
          target: thread.id,
          text: task,
          messageType: "follow_up",
        },
      });
      return { threadId: thread.id, parentThreadId, thread: summary, delivery };
    } catch (error) {
      return {
        threadId: thread.id,
        parentThreadId,
        thread: summary,
        status: "created",
        followUpError: error instanceof Error ? error.message : String(error),
        named,
      };
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("input must be an object");
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string, maxLength = 4096): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength
  )
    throw new Error(
      `${label} must be a non-empty string of at most ${maxLength} characters`,
    );
  return value;
}
