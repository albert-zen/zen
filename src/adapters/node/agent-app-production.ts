import { join, resolve } from 'node:path';

import { AgentAppServer, ProjectManager } from '../../product/index.js';
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
    rootPathNormalizer: (rootPath) => resolve(rootPath),
  });
  const agentAppServer = new AgentAppServer({
    projectManager,
    createRuntime: createAgentAppProjectRuntimeFactory({
      appDataRoot,
      config: options.config,
      createModel: options.createModel,
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
