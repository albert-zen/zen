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

  const server = new AppServer({
    ...options.appServerOptions,
    threadStore,
    threadManagerOptions: {
      ...options.appServerOptions?.threadManagerOptions,
      initialThreads,
      runtimeFactory: createOpenClawThreadRuntimeFactory(options)
    }
  });

  await persistLoadedThreads(server, threadStore);

  return server;
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

async function persistLoadedThreads(
  server: AppServer,
  threadStore: ThreadStore
): Promise<void> {
  const response = await server.request({ method: "thread/list" });

  if (!response.ok || response.method !== "thread/list") {
    return;
  }

  await Promise.all(
    response.result.threads.map((thread) => threadStore.save(thread))
  );
}
