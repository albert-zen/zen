import type {
  ToolExecutionResult,
  ToolInvocation,
  ToolProvider,
} from "../../../../src/tool.js";
import { ShellToolExecutor, ToolEnvironment } from "../../../../src/tool.js";
import type { ToolDefinitionProjection } from "../../../../src/runtime.js";
import type { CapabilityResultCommand, HostEvent } from "./host-messages.js";
import type { ZenXCapabilityHostSnapshot } from "./capabilities/types.js";
import {
  PluginDiscoveryProjection,
  PluginDiscoveryToolProvider,
} from "./plugin-discovery.js";

interface PendingInvocation {
  resolve(result: ToolExecutionResult): void;
  reject(error: Error): void;
  signal: AbortSignal;
  abort(): void;
}

export class ZenXHostToolExecutor implements ToolProvider {
  readonly identity = {
    kind: "external",
    id: "zenx-capability-host",
  } as const;
  readonly definitions;
  readonly #capabilityNames: Set<string>;
  readonly #send: (event: HostEvent) => void;
  readonly #pending = new Map<string, PendingInvocation>();

  constructor(options: {
    capabilities: ZenXCapabilityHostSnapshot;
    send: (event: HostEvent) => void;
  }) {
    this.#capabilityNames = new Set(
      options.capabilities.definitions.map((definition) => definition.name),
    );
    this.definitions = options.capabilities.definitions;
    this.#send = options.send;
  }

  async execute(invocation: ToolInvocation): Promise<ToolExecutionResult> {
    if (!this.#capabilityNames.has(invocation.name)) {
      throw new Error(`Unsupported tool: ${invocation.name}`);
    }
    invocation.signal.throwIfAborted();
    const invocationId = `${process.pid}:${invocation.callId}:${String(Date.now())}`;
    return await new Promise<ToolExecutionResult>((resolve, reject) => {
      const abort = (): void => {
        this.#pending.delete(invocationId);
        this.#send({ type: "capability/cancel", invocationId });
        reject(
          invocation.signal.reason ??
            new DOMException("The operation was aborted", "AbortError"),
        );
      };
      this.#pending.set(invocationId, {
        resolve,
        reject,
        signal: invocation.signal,
        abort,
      });
      invocation.signal.addEventListener("abort", abort, { once: true });
      this.#send({
        type: "capability/invoke",
        invocationId,
        invocation: {
          callId: invocation.callId,
          name: invocation.name,
          arguments: invocation.arguments,
          cwd: invocation.cwd,
        },
      });
    });
  }

  handleResult(command: CapabilityResultCommand): void {
    const pending = this.#pending.get(command.invocationId);
    if (pending === undefined) return;
    this.#pending.delete(command.invocationId);
    pending.signal.removeEventListener("abort", pending.abort);
    if (command.error === undefined) {
      pending.resolve({
        output: command.output ?? "",
        exitCode: command.exitCode ?? 1,
      });
    } else {
      pending.reject(new Error(command.error));
    }
  }

  close(reason = "ZenX capability bridge closed"): void {
    for (const pending of this.#pending.values()) {
      pending.signal.removeEventListener("abort", pending.abort);
      pending.reject(new Error(reason));
    }
    this.#pending.clear();
  }
}

export function createZenXHostToolEnvironment(options: {
  capabilities: ZenXCapabilityHostSnapshot;
  blockedEnvironmentVariables?: readonly string[];
  redactedValues?: readonly string[];
  send: (event: HostEvent) => void;
}): {
  capabilityProvider: ZenXHostToolExecutor;
  toolEnvironment: ToolEnvironment;
  toolDefinitionProjection: ToolDefinitionProjection;
} {
  const capabilityProvider = new ZenXHostToolExecutor({
    capabilities: options.capabilities,
    send: options.send,
  });
  const toolEnvironment = new ToolEnvironment({
    providers: [
      new ShellToolExecutor({
        blockedEnvironmentVariables: options.blockedEnvironmentVariables,
        redactedValues: options.redactedValues,
      }),
      capabilityProvider,
    ],
  });
  const catalog = {
    availablePlugins: () => structuredClone(options.capabilities.plugins ?? []),
  };
  toolEnvironment.registerProvider(
    new PluginDiscoveryToolProvider(catalog, toolEnvironment),
  );
  const projection = new PluginDiscoveryProjection(toolEnvironment, catalog);
  return {
    capabilityProvider,
    toolEnvironment,
    toolDefinitionProjection: (items) => projection.definitions(items),
  };
}
