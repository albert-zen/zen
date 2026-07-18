import {
  DEFAULT_ZEN_SYSTEM_PROMPT,
  toThreadSnapshot,
  type ThreadJournal,
  type ThreadPersistenceFailure,
  type ThreadRuntime,
  type ThreadRuntimeFactory,
} from '../../product/index.js';
import { AppServer, type AppServerOptions } from '../../product/app-server.js';
import { LocalToolRuntime, localToolDefinitions } from './local-tool-runtime.js';
import {
  loadModelProviderConfig,
  type ModelProviderConfigOptions,
} from './model-provider-config.js';
import { OpenAiCompatibleModelGateway } from './openai-compatible-model-gateway.js';
import { FileThreadJournal } from './file-thread-journal.js';

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
  try {
    const { initialThreads, persistenceFailures } = await replayThreadJournal(threadJournal);

    return new AppServer({
      ...options.appServerOptions,
      threadJournal,
      persistenceFailures,
      threadManagerOptions: {
        ...options.appServerOptions?.threadManagerOptions,
        initialThreads,
        runtimeFactory: createProviderThreadRuntimeFactory(options),
      },
    });
  } catch (cause) {
    try {
      await threadJournal.close();
    } catch (closeCause) {
      throw new AggregateError(
        [cause, closeCause],
        'Provider-backed AppServer startup and journal close failed',
        { cause: closeCause }
      );
    }
    throw cause;
  }
}

export async function replayThreadJournal(threadJournal: ThreadJournal): Promise<{
  readonly initialThreads: readonly ReturnType<typeof toThreadSnapshot>[];
  readonly persistenceFailures: readonly ThreadPersistenceFailure[];
}> {
  const replay = await threadJournal.replay();
  return {
    initialThreads: replay
      .filter(
        (result): result is Extract<typeof result, { type: 'success' }> => result.type === 'success'
      )
      .map((result) => toThreadSnapshot({ threadId: result.threadId, items: result.items })),
    persistenceFailures: replay.flatMap((result): readonly ThreadPersistenceFailure[] =>
      result.type === 'failure'
        ? [
            {
              code: 'THREAD_JOURNAL_CORRUPTION',
              message: result.error.message,
              path: result.path,
              recordNumber: result.error.recordNumber,
              threadId: result.threadId,
            },
          ]
        : []
    ),
  };
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
        tools: localToolDefinitions,
      }),
      toolRuntime: new LocalToolRuntime({ cwd: options.cwd, approvalBroker }),
      systemPrompt: DEFAULT_ZEN_SYSTEM_PROMPT,
    };
  };
}
