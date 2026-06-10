import { AppServer, type AppServerOptions } from "./app-server.js";
import { LocalToolRuntime, localToolDefinitions } from "./local-tool-runtime.js";
import {
  loadModelProviderConfig,
  type ModelProviderConfigOptions
} from "./model-provider-config.js";
import { OpenAiCompatibleModelGateway } from "./openai-compatible-model-gateway.js";
import { DEFAULT_ZEN_SYSTEM_PROMPT } from "./system-prompt.js";
import { FileThreadStore, type ThreadStore } from "./thread-store.js";
import type { ThreadRuntime, ThreadRuntimeFactory } from "./thread-manager.js";

export type ProviderBackedAppServerOptions = {
  readonly cwd?: string;
  readonly config?: ModelProviderConfigOptions;
  readonly threadStore?: ThreadStore;
  readonly appServerOptions?: AppServerOptions;
};

export async function createProviderBackedAppServer(
  options: ProviderBackedAppServerOptions = {}
): Promise<AppServer> {
  const threadStore = options.threadStore ?? new FileThreadStore();
  const initialThreads = await threadStore.list();

  const server = new AppServer({
    ...options.appServerOptions,
    threadStore,
    threadManagerOptions: {
      ...options.appServerOptions?.threadManagerOptions,
      initialThreads,
      runtimeFactory: createProviderThreadRuntimeFactory(options)
    }
  });

  await persistLoadedThreads(server, threadStore);

  return server;
}

export function createProviderThreadRuntimeFactory(
  options: ProviderBackedAppServerOptions = {}
): ThreadRuntimeFactory {
  return (): ThreadRuntime => {
    const config = loadModelProviderConfig(options.config);

    return {
      model: new OpenAiCompatibleModelGateway({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.modelId,
        defaultParams: config.params,
        tools: localToolDefinitions
      }),
      toolRuntime: new LocalToolRuntime({ cwd: options.cwd }),
      systemPrompt: DEFAULT_ZEN_SYSTEM_PROMPT
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
