import { randomUUID } from "node:crypto";
import { RtkShellOutputFilter } from "../../../../src/shell-output-filter.js";
import type {
  ToolBundle,
  ToolExecutionResult,
  ToolInvocation,
  ToolRuntime,
} from "../../../../src/tool.js";
import { ShellToolRuntime, ToolEnvironment } from "../../../../src/tool.js";
import type { ToolOutputSpool } from "../../../../src/tool-output-spool.js";
import type { ToolDefinitionProjection } from "../../../../src/runtime.js";
import type { CapabilityResultCommand, HostEvent } from "./host-messages.js";
import type { ZenXCapabilityHostSnapshot } from "./capabilities/types.js";
import {
  PluginDiscoveryProjection,
  PluginDiscoveryToolRuntime,
} from "./plugin-discovery.js";

interface PendingInvocation {
  resolve(result: ToolExecutionResult): void;
  reject(error: Error): void;
  signal: AbortSignal;
  abort(): void;
  generationToken: string;
}

interface CapabilityInvocationState {
  pending: Map<string, PendingInvocation>;
}

export class ZenXHostToolBundle implements ToolBundle {
  readonly identity = {
    kind: "external",
    id: "zenx-capability-host",
  } as const;
  readonly tools: readonly ToolRuntime[];
  readonly #send: (event: HostEvent) => void;
  readonly #state: CapabilityInvocationState;
  readonly #generationToken: string;
  readonly #drainWaiters = new Set<() => void>();
  #prepared = 0;
  #retiring = false;

  constructor(options: {
    capabilities: ZenXCapabilityHostSnapshot & { generationToken?: string };
    send: (event: HostEvent) => void;
    state?: CapabilityInvocationState;
  }) {
    this.tools = options.capabilities.definitions.map((definition) => ({
      name: definition.name,
      specification: structuredClone(definition),
      ...hostedResourcePolicy(
        definition.name,
        options.capabilities.plugins?.find((plugin) =>
          plugin.tools.some((tool) => tool.name === definition.name),
        )?.id,
      ),
      execute: async (invocation: ToolInvocation) =>
        await this.#execute(definition.name, invocation),
    }));
    this.#send = options.send;
    this.#state = options.state ?? { pending: new Map() };
    this.#generationToken = options.capabilities.generationToken ?? "legacy";
  }

  retainPreparedInvocation(): () => void {
    if (this.#retiring) {
      throw new Error(
        `Capability generation is retiring: ${this.#generationToken}`,
      );
    }
    this.#prepared += 1;
    let retained = true;
    return () => {
      if (!retained) return;
      retained = false;
      this.#prepared -= 1;
      this.#notifyDrain();
    };
  }

  async #execute(
    toolName: string,
    invocation: ToolInvocation,
  ): Promise<ToolExecutionResult> {
    if (invocation.name !== toolName) {
      throw new Error(
        `Tool runtime ${toolName} received invocation for ${invocation.name}`,
      );
    }
    invocation.signal.throwIfAborted();
    const invocationId = randomUUID();
    return await new Promise<ToolExecutionResult>((resolve, reject) => {
      const abort = (): void => {
        this.#send({
          type: "capability/cancel",
          invocationId,
          generationToken: this.#generationToken,
        });
        // Sending cancellation does not confirm that the provider stopped.
        // Keep the pending result so the task can observe actual completion.
      };
      this.#state.pending.set(invocationId, {
        resolve,
        reject,
        signal: invocation.signal,
        abort,
        generationToken: this.#generationToken,
      });
      invocation.signal.addEventListener("abort", abort, { once: true });
      this.#send({
        type: "capability/invoke",
        invocationId,
        generationToken: this.#generationToken,
        invocation: {
          callId: invocation.callId,
          ...(invocation.canonicalToolCallId === undefined
            ? {}
            : { canonicalToolCallId: invocation.canonicalToolCallId }),
          name: invocation.name,
          arguments: invocation.arguments,
          cwd: invocation.cwd,
          ...(invocation.threadId === undefined
            ? {}
            : { threadId: invocation.threadId }),
        },
      });
    });
  }

  handleResult(command: CapabilityResultCommand): void {
    const pending = this.#state.pending.get(command.invocationId);
    if (pending === undefined) return;
    if (pending.generationToken !== command.generationToken) return;
    this.#state.pending.delete(command.invocationId);
    pending.signal.removeEventListener("abort", pending.abort);
    if (command.error === undefined) {
      pending.resolve({
        output: command.output ?? "",
        exitCode: command.exitCode ?? 1,
        ...(command.contentType === undefined
          ? {}
          : {
              contentType: command.contentType,
              structuredContent: command.structuredContent,
            }),
        ...(command.sourceTruncated === undefined
          ? {}
          : { sourceTruncated: command.sourceTruncated }),
      });
    } else {
      pending.reject(new Error(command.error));
    }
  }

  close(reason = "ZenX capability bridge closed"): void {
    for (const pending of this.#state.pending.values()) {
      pending.signal.removeEventListener("abort", pending.abort);
      pending.reject(new Error(reason));
    }
    this.#state.pending.clear();
  }

  async retire(): Promise<void> {
    this.#retiring = true;
    while (this.#prepared > 0) {
      await new Promise<void>((resolve) => this.#drainWaiters.add(resolve));
    }
  }

  get generationToken(): string {
    return this.#generationToken;
  }

  #notifyDrain(): void {
    for (const resolve of this.#drainWaiters) resolve();
    this.#drainWaiters.clear();
  }
}

// Resource identities follow provider ownership, not the capability transport.
// BrowserThreadObservation namespaces public sessions by thread; tab IDs then
// identify one page within that session. Keep keys stable across generations so
// retiring calls remain fenced while a new snapshot is published.
function hostedResourcePolicy(toolName: string, pluginId: string | undefined) {
  const browserPageTools = new Set([
    "browser_navigate",
    "browser_inspect",
    "browser_click",
    "browser_type",
    "browser_scroll",
    "browser_select",
    "browser_fill",
    "browser_close",
  ]);
  if (
    pluginId === "browser" &&
    (browserPageTools.has(toolName) ||
      ["browser_open", "browser_list_tabs", "browser_close_session"].includes(
        toolName,
      ))
  ) {
    return {
      executionMode: "parallel_safe" as const,
      taskPolicy: { resourceQueue: "fifo" as const, yieldTimeMs: 30_000 },
      resourceClaims: (invocation: ToolInvocation) => {
        const sessionId = invocation.arguments.sessionId;
        const tabId = invocation.arguments.tabId;
        // Invalid arguments still reach normal schema/provider validation under
        // an exclusive fallback; malformed calls must not bypass a live fence.
        if (
          typeof sessionId !== "string" ||
          (browserPageTools.has(toolName) && typeof tabId !== "string")
        )
          return [
            { key: "zenx:browser:invalid", access: "exclusive" as const },
          ];
        const session = [
          "zenx-browser",
          invocation.threadId ?? null,
          sessionId,
        ];
        return browserPageTools.has(toolName)
          ? [
              { key: JSON.stringify(session), access: "shared" as const },
              {
                key: JSON.stringify([...session, tabId]),
                access: "exclusive" as const,
              },
            ]
          : [
              {
                key: JSON.stringify(session),
                access:
                  toolName === "browser_list_tabs"
                    ? ("shared" as const)
                    : ("exclusive" as const),
              },
            ];
      },
    };
  }
  if (pluginId === "computer") {
    return {
      taskPolicy: { resourceQueue: "fifo" as const, yieldTimeMs: 30_000 },
      resourceClaims: () => [
        { key: "zenx:desktop", access: "exclusive" as const },
      ],
    };
  }
  // Unknown plugins retain exclusive execution, but do not block an unrelated
  // plugin merely because both use the same IPC bridge.
  return pluginId === undefined
    ? {}
    : {
        taskPolicy: { resourceQueue: "fifo" as const },
        resourceClaims: () => [
          {
            key: JSON.stringify(["zenx-plugin", pluginId]),
            access: "exclusive" as const,
          },
        ],
      };
}

export function createZenXHostToolEnvironment(options: {
  experimentalRtk?: { executable: string; sha256: string };
  capabilities: ZenXCapabilityHostSnapshot & { generationToken?: string };
  blockedEnvironmentVariables?: readonly string[];
  send: (event: HostEvent) => void;
  toolOutputSpool: ToolOutputSpool;
}): {
  capabilityBundle: ZenXHostToolBundle;
  toolEnvironment: ToolEnvironment;
  toolDefinitionProjection: ToolDefinitionProjection;
  replaceCapabilities(
    capabilities: ZenXCapabilityHostSnapshot & { generationToken?: string },
  ): void;
  currentGenerationToken(): string;
  close(reason?: string): Promise<void>;
} {
  const invocationState: CapabilityInvocationState = { pending: new Map() };
  const capabilityBundle = new ZenXHostToolBundle({
    capabilities: options.capabilities,
    send: options.send,
    state: invocationState,
  });
  const shellRuntime = new ShellToolRuntime({
    blockedEnvironmentVariables: options.blockedEnvironmentVariables,
    toolOutputSpool: options.toolOutputSpool,
    experimentalOutputFilter:
      options.experimentalRtk === undefined
        ? undefined
        : new RtkShellOutputFilter(options.experimentalRtk),
  });
  const toolEnvironment = new ToolEnvironment({
    runtimes: [shellRuntime],
    toolOutputSpool: options.toolOutputSpool,
    bundles: [capabilityBundle],
  });
  let capabilities = structuredClone(options.capabilities);
  const catalog = {
    availablePlugins: () => structuredClone(capabilities.plugins ?? []),
  };
  toolEnvironment.registerRuntime(
    new PluginDiscoveryToolRuntime(catalog, toolEnvironment),
    {
      kind: "builtin",
      id: "zenx-plugin-discovery",
    },
  );
  const projection = new PluginDiscoveryProjection(toolEnvironment, catalog);
  const bundles = new Set([capabilityBundle]);
  const releasedBundles = new Set<ZenXHostToolBundle>();
  let currentBundle = capabilityBundle;
  const releaseGeneration = (bundle: ZenXHostToolBundle): void => {
    if (releasedBundles.has(bundle)) return;
    releasedBundles.add(bundle);
    options.send({
      type: "capabilities/released",
      generationToken: bundle.generationToken,
    });
  };
  const retire = (bundle: ZenXHostToolBundle): void => {
    void bundle.retire().then(() => {
      bundles.delete(bundle);
      releaseGeneration(bundle);
    });
  };
  return {
    capabilityBundle,
    toolEnvironment,
    toolDefinitionProjection: (items) => projection.definitions(items),
    replaceCapabilities: (replacement) => {
      const nextBundle = new ZenXHostToolBundle({
        capabilities: replacement,
        send: options.send,
        state: invocationState,
      });
      const staged = toolEnvironment.stageBundle(nextBundle, {
        replaceCurrent: true,
      });
      staged.publish();
      const previous = currentBundle;
      currentBundle = nextBundle;
      bundles.add(nextBundle);
      retire(previous);
      capabilities = structuredClone(replacement);
    },
    currentGenerationToken: () => currentBundle.generationToken,
    close: async (reason = "ZenX capability bridge closed") => {
      await toolEnvironment.close();
      capabilityBundle.close(reason);
      const retiring = [...bundles].map(async (bundle) => {
        await bundle.retire();
        releaseGeneration(bundle);
      });
      bundles.clear();
      await Promise.all(retiring);
    },
  };
}
