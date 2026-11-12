import type { ZenXPluginHostSdkV1 } from "@zenx/plugin-sdk";
export interface FleetTrustedInvocation {
  readonly callId: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly cwd: string;
  readonly signal: AbortSignal;
}
export interface FleetTrustedService {
  invoke(name: string, invocation: FleetTrustedInvocation): Promise<unknown>;
}
export function createZenXTrustedPlugin(service: FleetTrustedService) {
  return {
    start: async (_sdk: ZenXPluginHostSdkV1) => undefined,
    invoke: async (name: string, invocation: FleetTrustedInvocation) => {
      invocation.signal.throwIfAborted();
      return await service.invoke(name, invocation);
    },
    close: async () => undefined,
  };
}
