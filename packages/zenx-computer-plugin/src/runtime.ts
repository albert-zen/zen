import type { ZenXPluginHostSdkV1 } from "@zenx/plugin-sdk";

export interface TrustedInvocation {
  readonly callId: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly cwd: string;
  readonly signal: AbortSignal;
}
export interface ComputerTrustedService {
  invoke(toolName: string, invocation: TrustedInvocation): Promise<unknown>;
}
export function createZenXTrustedPlugin(service: ComputerTrustedService) {
  return {
    start: async (_sdk: ZenXPluginHostSdkV1) => undefined,
    invoke: async (toolName: string, invocation: TrustedInvocation) => {
      invocation.signal.throwIfAborted();
      return await service.invoke(toolName, invocation);
    },
    close: async () => undefined,
  };
}
