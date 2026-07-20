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
import type { CodexAppServerLoginInput } from './codex-app-server-client.js';
import { CodexProviderService, type CodexProviderStatus } from './codex-provider-service.js';

export type AgentAppServerConfiguration = AgentAppProjectRuntimeFactoryOptions & {
  /** Registry location is explicit and always rooted under appDataRoot. */
  readonly registryPath?: string;
};

export type AgentAppProductionComposition = {
  readonly agentAppServer: AgentAppServer;
  readonly projectManager: ProjectManager;
  readonly codexProviderService: CodexProviderService;
  close(): Promise<void>;
};

export async function createAgentAppServer(
  options: AgentAppServerConfiguration
): Promise<AgentAppServer> {
  return (await createAgentAppProductionComposition(options)).agentAppServer;
}

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
  const codexProviderService = options.codexProviderService ?? new CodexProviderService();
  const agentAppServer: AgentAppServer = new AgentAppServer({
    projectManager,
    commandLedger,
    providerControl: createCodexProviderControl(codexProviderService),
    createRuntime: createAgentAppProjectRuntimeFactory({
      appDataRoot,
      config: options.config,
      createModel: options.createModel,
      codexProviderService,
      requestAgentApp: async (request, context): Promise<AgentAppResponse> =>
        await agentAppServer.requestFromAgent(request, context),
    }),
  });
  let closePromise: Promise<void> | undefined;
  return {
    agentAppServer,
    projectManager,
    codexProviderService,
    close: () => {
      closePromise ??= closeComposition(agentAppServer, codexProviderService);
      return closePromise;
    },
  };
}

function createCodexProviderControl(provider: CodexProviderService): ProviderControl {
  return {
    read: async () => providerStatusJson(await provider.status()),
    refresh: async () => providerStatusJson(await provider.refresh()),
    loginStart: async (input) => await provider.startLogin(parseCodexLoginInput(input)),
    loginCancel: async (input) => await provider.cancelLogin(requiredLoginId(input)),
    logout: async (input) => {
      requireEmptyInput(input, 'provider/logout');
      return await provider.logout();
    },
  };
}

function providerStatusJson(status: CodexProviderStatus): JsonValue {
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

function parseCodexLoginInput(input: JsonObject): CodexAppServerLoginInput {
  if (input.type === 'chatgptDeviceCode') {
    requireOnlyKeys(input, ['type'], 'provider/login/start');
    return { type: 'chatgptDeviceCode' };
  }
  if (input.type !== 'chatgpt') {
    throw new Error('provider/login/start requires type chatgpt or chatgptDeviceCode');
  }
  requireOnlyKeys(
    input,
    ['type', 'codexStreamlinedLogin', 'useHostedLoginSuccessPage', 'appBrand'],
    'provider/login/start'
  );
  const codexStreamlinedLogin = optionalBoolean(
    input.codexStreamlinedLogin,
    'codexStreamlinedLogin'
  );
  const useHostedLoginSuccessPage = optionalBoolean(
    input.useHostedLoginSuccessPage,
    'useHostedLoginSuccessPage'
  );
  const appBrand = optionalAppBrand(input.appBrand);
  return {
    type: 'chatgpt',
    ...(codexStreamlinedLogin === undefined ? {} : { codexStreamlinedLogin }),
    ...(useHostedLoginSuccessPage === undefined ? {} : { useHostedLoginSuccessPage }),
    ...(appBrand === undefined ? {} : { appBrand }),
  };
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

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`);
  return value;
}

function optionalAppBrand(value: unknown): 'codex' | 'chatgpt' | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === 'codex' || value === 'chatgpt') return value;
  throw new Error('appBrand must be codex, chatgpt, or null');
}

async function closeComposition(
  agentAppServer: AgentAppServer,
  codexProviderService: CodexProviderService
): Promise<void> {
  const failures: unknown[] = [];
  const server = await Promise.allSettled([agentAppServer.close()]);
  failures.push(
    ...server.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
  );
  const provider = await Promise.allSettled([codexProviderService.close()]);
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
