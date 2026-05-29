import { AppServer, type AppServerOptions } from "./app-server.js";
import { LocalToolRuntime, localToolDefinitions } from "./local-tool-runtime.js";
import { loadOpenClawModelConfig, type OpenClawConfigOptions } from "./openclaw-config.js";
import { OpenAiCompatibleModelGateway } from "./openai-compatible-model-gateway.js";
import { FileThreadStore, type ThreadStore } from "./thread-store.js";
import type { ThreadRuntime, ThreadRuntimeFactory } from "./thread-manager.js";

export type OpenClawAppServerOptions = {
  readonly cwd?: string;
  readonly config?: OpenClawConfigOptions;
  readonly threadStore?: ThreadStore;
  readonly appServerOptions?: AppServerOptions;
};

export async function createOpenClawAppServer(
  options: OpenClawAppServerOptions = {}
): Promise<AppServer> {
  const threadStore = options.threadStore ?? new FileThreadStore();
  const initialThreads = await threadStore.list();

  return new AppServer({
    ...options.appServerOptions,
    threadStore,
    threadManagerOptions: {
      ...options.appServerOptions?.threadManagerOptions,
      initialThreads,
      runtimeFactory: createOpenClawThreadRuntimeFactory(options)
    }
  });
}

export function createOpenClawThreadRuntimeFactory(
  options: OpenClawAppServerOptions = {}
): ThreadRuntimeFactory {
  return (): ThreadRuntime => {
    const config = loadOpenClawModelConfig(options.config);

    return {
      model: new OpenAiCompatibleModelGateway({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.modelId,
        defaultParams: config.params,
        tools: localToolDefinitions
      }),
      toolRuntime: new LocalToolRuntime({ cwd: options.cwd })
    };
  };
}
