import { realpath } from 'node:fs/promises';
import { platform } from 'node:os';
import { join, resolve } from 'node:path';

import {
  AgentAppServer,
  ProjectCommandLedger,
  ProjectManager,
  type AgentAppResponse,
  type JsonObject,
  type JsonValue,
  type ProviderControl,
} from '../../product/index.js';
import { FileProjectCommandStore } from './file-project-command-store.js';
import { FileProjectRegistry } from './file-project-registry.js';
import {
  createAgentAppProjectRuntimeFactory,
  type AgentAppProjectRuntimeFactoryOptions,
} from './agent-app-runtime.js';
import {
  OpenAISubscriptionProviderService,
  type OpenAISubscriptionLoginInput,
  type OpenAISubscriptionProviderStatus,
} from './openai-subscription-provider-service.js';

export type AgentAppServerConfiguration = AgentAppProjectRuntimeFactoryOptions & {
  /** Registry location is explicit and always rooted under appDataRoot. */
  readonly registryPath?: string;
};

export type AgentAppProductionComposition = {
  readonly agentAppServer: AgentAppServer;
  readonly projectManager: ProjectManager;
  readonly openaiSubscriptionProviderService: OpenAISubscriptionProviderService;
  close(): Promise<void>;
};

/**
 * The default CLI deliberately does not consume this composition until APP-005C.
 * Its data root, provider configuration, and transport capability are all
 * supplied by the caller rather than inferred from the working directory.
 */
export async function createAgentAppProductionComposition(
  options: AgentAppServerConfiguration
): Promise<AgentAppProductionComposition> {
  const appDataRoot = resolve(options.appDataRoot);
  const projectManager = await ProjectManager.open({
    registry: new FileProjectRegistry({
      filePath: options.registryPath ?? join(appDataRoot, 'projects.json'),
    }),
    rootPathNormalizer: canonicalizeProjectRootPath,
  });
  const commandLedger = await ProjectCommandLedger.open(
    new FileProjectCommandStore(join(appDataRoot, 'commands.json'))
  );
  const openaiSubscriptionProviderService =
    options.openaiSubscriptionProviderService ??
    new OpenAISubscriptionProviderService({ appDataRoot });
  const agentAppServer: AgentAppServer = new AgentAppServer({
    projectManager,
    commandLedger,
    providerControl: createOpenAISubscriptionProviderControl(openaiSubscriptionProviderService),
    createRuntime: createAgentAppProjectRuntimeFactory({
      appDataRoot,
      createModel: options.createModel,
      openaiSubscriptionProviderService,
      requestAgentApp: async (request, context): Promise<AgentAppResponse> =>
        await agentAppServer.requestFromAgent(request, context),
    }),
  });
  let closePromise: Promise<void> | undefined;
  return {
    agentAppServer,
    projectManager,
    openaiSubscriptionProviderService,
    close: () => {
      if (closePromise) return closePromise;
      const attempt = closeComposition(agentAppServer, openaiSubscriptionProviderService);
      closePromise = attempt;
      void attempt.catch(() => {
        if (closePromise === attempt) closePromise = undefined;
      });
      return attempt;
    },
  };
}

function createOpenAISubscriptionProviderControl(
  provider: OpenAISubscriptionProviderService
): ProviderControl {
  return {
    read: async () => providerStatusJson(await provider.status()),
    refresh: async () => providerStatusJson(await provider.refresh()),
    loginStart: async (input) =>
      await provider.startLogin(parseOpenAISubscriptionLoginInput(input)),
    loginCancel: async (input) => await provider.cancelLogin(requiredLoginId(input)),
    logout: async (input) => {
      requireEmptyInput(input, 'provider/logout');
      return await provider.logout();
    },
  };
}

function providerStatusJson(status: OpenAISubscriptionProviderStatus): JsonValue {
  return jsonValue(status);
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((entry) => jsonValue(entry));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Readonly<Record<string, unknown>>)
        .filter(([key, entry]) => entry !== undefined && !credentialKey.test(key))
        .map(([key, entry]) => [key, jsonValue(entry)])
    ) as JsonObject;
  }
  return null;
}

const credentialKey = /(?:api)?key|token|secret|password/i;

function parseOpenAISubscriptionLoginInput(input: JsonObject): OpenAISubscriptionLoginInput {
  if (input.type === 'chatgptDeviceCode') {
    requireOnlyKeys(input, ['type'], 'provider/login/start');
    return { type: 'chatgptDeviceCode' };
  }
  if (input.type !== 'chatgpt') {
    throw new Error('provider/login/start requires type chatgpt or chatgptDeviceCode');
  }
  requireOnlyKeys(input, ['type'], 'provider/login/start');
  return { type: 'chatgpt' };
}

function requiredLoginId(input: JsonObject): string {
  requireOnlyKeys(input, ['loginId'], 'provider/login/cancel');
  if (typeof input.loginId !== 'string' || input.loginId.length === 0) {
    throw new Error('provider/login/cancel requires loginId');
  }
  return input.loginId;
}

function requireEmptyInput(input: JsonObject, method: string): void {
  requireOnlyKeys(input, [], method);
}

function requireOnlyKeys(input: JsonObject, allowed: readonly string[], method: string): void {
  const unexpected = Object.keys(input).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`${method} does not accept ${unexpected}`);
}

async function closeComposition(
  agentAppServer: AgentAppServer,
  openaiSubscriptionProviderService: OpenAISubscriptionProviderService
): Promise<void> {
  const failures: unknown[] = [];
  const server = await Promise.allSettled([agentAppServer.close()]);
  failures.push(
    ...server.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
  );
  const provider = await Promise.allSettled([openaiSubscriptionProviderService.close()]);
  failures.push(
    ...provider.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
  );
  if (failures.length > 0)
    throw new AggregateError(failures, 'Production composition close failed');
}

export async function canonicalizeProjectRootPath(rootPath: string): Promise<string> {
  const canonical = await realpath(resolve(rootPath));
  return platform() === 'win32' ? canonical.toLowerCase() : canonical;
}
