import type { AgentAppClient, AgentAppRequest } from '../../product/index.js';
import { parseAgentAppRequest } from '../../product/index.js';
import type { AppServerClient } from '../../product/app-server.js';
import type {
  AppServerNotification,
  AppServerResponse,
} from '../../product/app-server-protocol.js';
import {
  serveAppServerHttpTransport,
  createAppServerHttpProxy,
  type AppServerHttpTransport,
  type AppServerHttpTransportOptions,
} from './app-server-transport.js';

/**
 * Agent App uses the same HTTP/SSE lifecycle core as the legacy AppServer.
 * Only the protocol adapter differs; cursor ownership and capability checks
 * remain in the provider-neutral transport.
 */
export type AgentAppHttpTransportOptions = Omit<
  AppServerHttpTransportOptions,
  'appServer' | 'parseRequest'
> & {
  readonly agentAppServer: AgentAppClient;
};

export type AgentAppHttpTransport = AppServerHttpTransport;

export function createAgentAppHttpProxy(target: string, capability: string) {
  return createAppServerHttpProxy(target, capability);
}

export async function serveAgentAppHttpTransport(
  options: AgentAppHttpTransportOptions
): Promise<AgentAppHttpTransport> {
  const appServer: AppServerClient = {
    async request(request): Promise<AppServerResponse> {
      return (await options.agentAppServer.request(
        request as AgentAppRequest
      )) as unknown as AppServerResponse;
    },
    subscribe(listener) {
      return options.agentAppServer.subscribe((notification) => {
        listener(notification as unknown as AppServerNotification);
      });
    },
  };
  return await serveAppServerHttpTransport({
    ...options,
    appServer,
    parseRequest: parseAgentAppRequest,
  });
}
