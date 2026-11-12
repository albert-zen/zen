import type { ZenXPluginHostSdkV1 } from "@zenx/plugin-sdk";
export interface BoardTrustedService {
  start?(sdk: ZenXPluginHostSdkV1): Promise<void> | void;
  invoke(
    name: string,
    invocation: {
      callId: string;
      arguments: Readonly<Record<string, unknown>>;
      cwd: string;
      signal: AbortSignal;
    },
  ): Promise<unknown>;
}
export function createZenXTrustedPlugin(service: BoardTrustedService) {
  return {
    start: async (sdk: ZenXPluginHostSdkV1) => await service.start?.(sdk),
    invoke: async (
      name: string,
      invocation: Parameters<BoardTrustedService["invoke"]>[1],
    ) => {
      invocation.signal.throwIfAborted();
      return await service.invoke(name, invocation);
    },
    close: async () => undefined,
  };
}
