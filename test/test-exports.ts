// Test-only aggregation keeps production boundaries explicit while allowing
// existing characterization tests to exercise composed product behavior.
export * from '../src/kernel/index.js';
export * from '../src/product/index.js';
export * from '../src/adapters/node/index.js';
export * from '../src/presentation/index.js';
export * from '../src/tui/index.js';
// Legacy runtime characterization tests remain internal-only during protocol
// migration; no package entry point re-exports these symbols.
export * from '../src/product/app-server.js';
export * from '../src/product/app-server-protocol.js';
export * from '../src/product/demo-runtime.js';
export * from '../src/adapters/node/app-server-transport.js';
export * from '../src/adapters/node/provider-runtime.js';

// Tests retained from the prior protocol use this local-only compatibility
// constructor; production presentation exports only BrowserAgentAppTransportClient.
import { BrowserAgentAppTransportClient } from '../src/presentation/web-ui-client.js';
type LegacyBrowserNotification = {
  readonly type: string;
  readonly threads?: readonly { id: string }[];
};
type LegacyBrowserClient = {
  request(request: unknown): Promise<unknown>;
  subscribe(listener: (notification: LegacyBrowserNotification) => void): () => void;
};
export const BrowserAppServerTransportClient: new (options: {
  readonly fetch?: typeof fetch;
  readonly createEventSource?: (url: string) => unknown;
  readonly onSubscriptionStatus?: (status: string, error?: unknown) => void;
}) => LegacyBrowserClient = BrowserAgentAppTransportClient as unknown as new (options: {
  readonly fetch?: typeof fetch;
  readonly createEventSource?: (url: string) => unknown;
  readonly onSubscriptionStatus?: (status: string, error?: unknown) => void;
}) => LegacyBrowserClient;
