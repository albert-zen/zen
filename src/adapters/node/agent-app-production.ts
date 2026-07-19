import { realpath } from 'node:fs/promises';
import { platform } from 'node:os';
import { join, resolve } from 'node:path';

import {
  AgentAppServer,
  ProjectCommandLedger,
  ProjectManager,
  type AgentAppResponse,
} from '../../product/index.js';
import { FileProjectCommandStore } from './file-project-command-store.js';
import { FileProjectRegistry } from './file-project-registry.js';
import {
  createAgentAppProjectRuntimeFactory,
  type AgentAppProjectRuntimeFactoryOptions,
} from './agent-app-runtime.js';

export type AgentAppServerConfiguration = AgentAppProjectRuntimeFactoryOptions & {
  /** Registry location is explicit and always rooted under appDataRoot. */
  readonly registryPath?: string;
};

export type AgentAppProductionComposition = {
  readonly agentAppServer: AgentAppServer;
  readonly projectManager: ProjectManager;
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
  const agentAppServer: AgentAppServer = new AgentAppServer({
    projectManager,
    commandLedger,
    createRuntime: createAgentAppProjectRuntimeFactory({
      appDataRoot,
      config: options.config,
      createModel: options.createModel,
      requestAgentApp: async (request, context): Promise<AgentAppResponse> =>
        await agentAppServer.requestFromAgent(request, context),
    }),
  });
  let closePromise: Promise<void> | undefined;
  return {
    agentAppServer,
    projectManager,
    close: () => {
      closePromise ??= agentAppServer.close();
      return closePromise;
    },
  };
}

export async function canonicalizeProjectRootPath(rootPath: string): Promise<string> {
  const canonical = await realpath(resolve(rootPath));
  return platform() === 'win32' ? canonical.toLowerCase() : canonical;
}
