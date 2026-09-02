import type {
  ToolExecutionResult,
  ToolInvocation,
  ToolProvider,
} from "../../../../src/tool.js";
import { ShellToolExecutor, ToolEnvironment } from "../../../../src/tool.js";
import type { ToolOutputSpool } from "../../../../src/tool-output-spool.js";
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

interface CapabilityInvocationState {
  pending: Map<string, PendingInvocation>;
}

export class ZenXHostToolExecutor implements ToolProvider {
  readonly identity = {
    kind: "external",
    id: "zenx-capability-host",
  } as const;
  readonly definitions;
  readonly #capabilityNames: Set<string>;
  readonly #send: (event: HostEvent) => void;
  readonly #state: CapabilityInvocationState;

  constructor(options: {
    capabilities: ZenXCapabilityHostSnapshot;
    send: (event: HostEvent) => void;
    state?: CapabilityInvocationState;
  }) {
    this.#capabilityNames = new Set(
      options.capabilities.definitions.map((definition) => definition.name),
    );
    this.definitions = options.capabilities.definitions;
    this.#send = options.send;
    this.#state = options.state ?? { pending: new Map() };
  }

  async execute(invocation: ToolInvocation): Promise<ToolExecutionResult> {
    if (!this.#capabilityNames.has(invocation.name)) {
      throw new Error(`Unsupported tool: ${invocation.name}`);
    }
    invocation.signal.throwIfAborted();
    const invocationId = `${process.pid}:${invocation.callId}:${String(Date.now())}`;
    return await new Promise<ToolExecutionResult>((resolve, reject) => {
      const abort = (): void => {
        this.#state.pending.delete(invocationId);
        this.#send({ type: "capability/cancel", invocationId });
        reject(
          invocation.signal.reason ??
            new DOMException("The operation was aborted", "AbortError"),
        );
      };
      this.#state.pending.set(invocationId, {
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
    const pending = this.#state.pending.get(command.invocationId);
    if (pending === undefined) return;
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
}

export function createZenXHostToolEnvironment(options: {
  capabilities: ZenXCapabilityHostSnapshot;
  blockedEnvironmentVariables?: readonly string[];
  redactedValues?: readonly string[];
  send: (event: HostEvent) => void;
  toolOutputSpool: ToolOutputSpool;
}): {
  capabilityProvider: ZenXHostToolExecutor;
  toolEnvironment: ToolEnvironment;
  toolDefinitionProjection: ToolDefinitionProjection;
  replaceCapabilities(capabilities: ZenXCapabilityHostSnapshot): void;
} {
  const invocationState: CapabilityInvocationState = { pending: new Map() };
  const capabilityProvider = new ZenXHostToolExecutor({
    capabilities: options.capabilities,
    send: options.send,
    state: invocationState,
  });
  const toolEnvironment = new ToolEnvironment({
    providers: [
      new ShellToolExecutor({
        blockedEnvironmentVariables: options.blockedEnvironmentVariables,
        redactedValues: options.redactedValues,
        toolOutputSpool: options.toolOutputSpool,
      }),
      capabilityProvider,
    ],
  });
  let capabilities = structuredClone(options.capabilities);
  const catalog = {
    availablePlugins: () => structuredClone(capabilities.plugins ?? []),
  };
  toolEnvironment.registerProvider(
    new PluginDiscoveryToolProvider(catalog, toolEnvironment),
  );
  const projection = new PluginDiscoveryProjection(toolEnvironment, catalog);
  return {
    capabilityProvider,
    toolEnvironment,
    toolDefinitionProjection: (items) => projection.definitions(items),
    replaceCapabilities: (replacement) => {
      const nextProvider = new ZenXHostToolExecutor({
        capabilities: replacement,
        send: options.send,
        state: invocationState,
      });
      const staged = toolEnvironment.stageProvider(nextProvider, {
        replaceCurrent: true,
      });
      staged.publish();
      capabilities = structuredClone(replacement);
    },
  };
}
