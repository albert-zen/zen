import type { AgentAppNotificationEnvelope, AgentAppServer } from '../../product/index.js';
import { parseAgentAppRequest } from '../../product/index.js';
import type {
  AppServerClient,
  AppServerNotification,
  AppServerResponse,
} from '../../product/index.js';
import {
  serveAppServerHttpTransport,
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
  readonly agentAppServer: AgentAppServer;
};

export type AgentAppHttpTransport = AppServerHttpTransport;

export async function serveAgentAppHttpTransport(
  options: AgentAppHttpTransportOptions
): Promise<AgentAppHttpTransport> {
  const appServer: AppServerClient = {
    async request(request): Promise<AppServerResponse> {
      return (await options.agentAppServer.request(request)) as unknown as AppServerResponse;
    },
    subscribe(listener) {
      return options.agentAppServer.observe((notification) => {
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

export function readAgentAppNotification(value: unknown): AgentAppNotificationEnvelope {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('projectId' in value) ||
    typeof value.projectId !== 'string' ||
    !('notification' in value) ||
    typeof value.notification !== 'object' ||
    value.notification === null
  ) {
    throw new Error('Invalid Agent App notification envelope');
  }
  return value as AgentAppNotificationEnvelope;
}
