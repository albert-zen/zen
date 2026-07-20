import type {
  AgentAppClient,
  AgentAppNotificationEnvelope,
  AgentAppRequest,
  AgentAppResponse,
} from '../../product/index.js';
import { parseAgentAppRequest } from '../../product/index.js';
import type { AppServerClient } from '../../product/app-server.js';
import type {
  AppServerNotification,
  AppServerResponse,
} from '../../product/app-server-protocol.js';
import {
  createAppServerHttpProxy,
  HttpAppServerClient,
  serveAppServerHttpTransport,
  type AppServerHttpTransport,
  type AppServerHttpTransportOptions,
  type HttpAppServerClientOptions,
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

export type HttpAgentAppClientOptions = HttpAppServerClientOptions;

/** Public Node client for the project-scoped Agent App protocol. */
export class HttpAgentAppClient implements AgentAppClient {
  private readonly client: HttpAppServerClient;

  constructor(options: HttpAgentAppClientOptions) {
    this.client = new HttpAppServerClient(options);
  }

  async request(request: AgentAppRequest): Promise<AgentAppResponse> {
    return (await this.client.request(request as never)) as unknown as AgentAppResponse;
  }

  subscribe(listener: (notification: AgentAppNotificationEnvelope) => void): () => void {
    return this.client.subscribe((notification) => {
      listener(notification as unknown as AgentAppNotificationEnvelope);
    });
  }

  async close(): Promise<void> {
    await this.client.close();
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
