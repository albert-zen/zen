import type { ZenXPluginHostSdkV1 } from "@zenx/plugin-sdk";

export interface TrustedInvocation {
  readonly callId: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly cwd: string;
  readonly signal: AbortSignal;
}
export interface TriggersTrustedService {
  start?(sdk: ZenXPluginHostSdkV1): Promise<void>;
  invoke(toolName: string, invocation: TrustedInvocation): Promise<unknown>;
  close?(): Promise<void>;
}
export function createZenXTrustedPlugin(service: TriggersTrustedService) {
  return {
    storage: {
      version: 1 as const,
      initialValue: { triggers: [], history: [] },
    },
    start: async (sdk: ZenXPluginHostSdkV1) => await service.start?.(sdk),
    invoke: async (toolName: string, invocation: TrustedInvocation) => {
      invocation.signal.throwIfAborted();
      return await service.invoke(toolName, invocation);
    },
    close: async () => await service.close?.(),
  };
}
