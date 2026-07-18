import type {
  AgentAppClient,
  AgentAppNotificationEnvelope,
  AgentAppNotificationListener,
  AgentAppRequest,
  AgentAppResponse,
  AgentAppSubscription,
} from '../../product/index.js';
import { parseAgentAppRequest } from '../../product/index.js';
import type { AppServerClient } from '../../product/app-server.js';
import type {
  AppServerNotification,
  AppServerResponse,
} from '../../product/app-server-protocol.js';
import {
  serveAppServerHttpTransport,
  createAppServerHttpProxy,
  HttpAppServerClient,
  type HttpAppServerClientOptions,
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

export type AgentAppTransportClientOptions = HttpAppServerClientOptions;

/**
 * The legacy HTTP client supplies the transport lifecycle, replay, and reset
 * gate.  This adapter makes the project envelope the only public payload.
 */
export class AgentAppTransportClient implements AgentAppClient {
  private readonly client: HttpAppServerClient;

  constructor(options: AgentAppTransportClientOptions) {
    this.client = new HttpAppServerClient(options);
  }

  async request(request: AgentAppRequest): Promise<AgentAppResponse> {
    return (await this.client.request(request)) as unknown as AgentAppResponse;
  }

  subscribe(listener: AgentAppNotificationListener): AgentAppSubscription {
    return this.client.subscribe((notification) =>
      listener(readAgentAppNotification(notification))
    );
  }
}

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
