import type {
  ToolExecutionResult,
  ToolExecutor,
  ToolInvocation,
} from "../../../../src/tool.js";
import { ShellToolExecutor } from "../../../../src/tool.js";
import type { CapabilityResultCommand, HostEvent } from "./host-messages.js";
import type { ZenXCapabilityHostSnapshot } from "./capabilities/types.js";

interface PendingInvocation {
  resolve(result: ToolExecutionResult): void;
  reject(error: Error): void;
  signal: AbortSignal;
  abort(): void;
}

export class ZenXHostToolExecutor implements ToolExecutor {
  readonly definitions;
  readonly #shell: ShellToolExecutor;
  readonly #capabilityNames: Set<string>;
  readonly #send: (event: HostEvent) => void;
  readonly #pending = new Map<string, PendingInvocation>();

  constructor(options: {
    capabilities: ZenXCapabilityHostSnapshot;
    blockedEnvironmentVariables?: readonly string[];
    redactedValues?: readonly string[];
    send: (event: HostEvent) => void;
  }) {
    this.#shell = new ShellToolExecutor({
      blockedEnvironmentVariables: options.blockedEnvironmentVariables,
      redactedValues: options.redactedValues,
    });
    this.#capabilityNames = new Set(
      options.capabilities.definitions.map((definition) => definition.name),
    );
    this.definitions = [
      ...this.#shell.definitions,
      ...options.capabilities.definitions,
    ];
    this.#send = options.send;
  }

  async execute(invocation: ToolInvocation): Promise<ToolExecutionResult> {
    if (invocation.name === "shell")
      return await this.#shell.execute(invocation);
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
