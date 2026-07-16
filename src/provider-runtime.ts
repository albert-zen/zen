import { AppServer, type AppServerOptions } from "./app-server.js";
import { LocalToolRuntime, localToolDefinitions } from "./local-tool-runtime.js";
import {
  loadModelProviderConfig,
  type ModelProviderConfigOptions
} from "./model-provider-config.js";
import { OpenAiCompatibleModelGateway } from "./openai-compatible-model-gateway.js";
import { DEFAULT_ZEN_SYSTEM_PROMPT } from "./system-prompt.js";
import { FileThreadJournal, type ThreadJournal } from "./thread-journal.js";
import { toThreadSnapshot } from "./app-server-protocol.js";
import type { ThreadRuntime, ThreadRuntimeFactory } from "./thread-manager.js";

export type ProviderBackedAppServerOptions = {
  readonly cwd?: string;
  readonly config?: ModelProviderConfigOptions;
  readonly threadJournal?: ThreadJournal;
  readonly appServerOptions?: AppServerOptions;
};

export async function createProviderBackedAppServer(
  options: ProviderBackedAppServerOptions = {}
): Promise<AppServer> {
  const threadJournal = options.threadJournal ?? new FileThreadJournal();
  const replay = await threadJournal.replay();
  const initialThreads = replay.filter((result): result is Extract<typeof result, { type: "success" }> => result.type === "success").map((result) => toThreadSnapshot({ threadId: result.threadId, items: result.items }));

  const server = new AppServer({
    ...options.appServerOptions,
    threadJournal,
    threadManagerOptions: {
      ...options.appServerOptions?.threadManagerOptions,
      initialThreads,
      runtimeFactory: createProviderThreadRuntimeFactory(options)
    }
  });

  return server;
}

export function createProviderThreadRuntimeFactory(
  options: ProviderBackedAppServerOptions = {}
): ThreadRuntimeFactory {
  return ({ approvalBroker }): ThreadRuntime => {
    const config = loadModelProviderConfig(options.config);

    return {
      model: new OpenAiCompatibleModelGateway({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.modelId,
        defaultParams: config.params,
        tools: localToolDefinitions
      }),
      toolRuntime: new LocalToolRuntime({ cwd: options.cwd, approvalBroker }),
      systemPrompt: DEFAULT_ZEN_SYSTEM_PROMPT
    };
  };
}
