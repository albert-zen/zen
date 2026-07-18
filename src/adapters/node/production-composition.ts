import type { AppServerClient } from '../../product/index.js';
import type {
  AppServerClientHandoff,
  AppServerCredentialMode,
  PublishedAppServerClientHandoff,
} from './app-server-config.js';
import type { AppServerHttpTransport } from './app-server-transport.js';

export type ShutdownTask = {
  readonly name: string;
  close(): void | Promise<void>;
};

export type AggregateProductionShutdownOptions = {
  readonly ingress?: readonly ShutdownTask[];
  readonly product?: readonly ShutdownTask[];
  readonly edge?: readonly ShutdownTask[];
};

export class ProductionResourceShutdownError extends Error {
  constructor(
    readonly phase: 'ingress' | 'product' | 'edge',
    readonly resource: string,
    cause: unknown
  ) {
    super(`${phase} shutdown failed for ${resource}: ${readErrorMessage(cause)}`, { cause });
    this.name = 'ProductionResourceShutdownError';
  }
}

export class AggregateProductionShutdown {
  private closePromise?: Promise<void>;

  constructor(private readonly options: AggregateProductionShutdownOptions) {}

  close(): Promise<void> {
    this.closePromise ??= this.closeResources();
    return this.closePromise;
  }

  private async closeResources(): Promise<void> {
    const failures: ProductionResourceShutdownError[] = [];

    await settlePhase('ingress', this.options.ingress ?? [], failures);
    await settlePhase('product', this.options.product ?? [], failures);
    await settlePhase('edge', this.options.edge ?? [], failures);

    if (failures.length > 0) {
      throw new AggregateError(failures, 'Production shutdown failed');
    }
  }
}

export interface ShutdownSignalSource {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'message', listener: (message: unknown) => void): unknown;
}

export type OwnedAppServer = AppServerClient & {
  close(): Promise<void>;
};

export type AppServerCliCompositionOptions = {
  readonly credentialMode: AppServerCredentialMode;
  readonly signalSource: ShutdownSignalSource;
  readonly createAppServer: () => Promise<OwnedAppServer>;
  readonly createTransport: (
    appServer: AppServerClient,
    capability: string | undefined
  ) => Promise<AppServerHttpTransport>;
  readonly publishHandoff?: (
    directory: string,
    handoff: AppServerClientHandoff
  ) => Promise<PublishedAppServerClientHandoff>;
  readonly cleanupHandoff?: (handoff: PublishedAppServerClientHandoff) => Promise<void>;
  readonly onHandoffPublished?: (handoff: PublishedAppServerClientHandoff) => void | Promise<void>;
  readonly onListening?: (
    transport: AppServerHttpTransport,
    handoff: PublishedAppServerClientHandoff | undefined
  ) => void | Promise<void>;
};

export async function runAppServerCliComposition(
  options: AppServerCliCompositionOptions
): Promise<void> {
  assertHandoffDependencies(options);
  let appServer: OwnedAppServer | undefined;
  let transport: AppServerHttpTransport | undefined;
  let publishedHandoff: PublishedAppServerClientHandoff | undefined;
  let hasPrimaryFailure = false;
  let primaryFailure: unknown;
  const shutdownSignal = createShutdownSignalWaiter(options.signalSource, true);

  try {
    if (!shutdownSignal.requested) appServer = await options.createAppServer();
    if (appServer && !shutdownSignal.requested) {
      transport = await options.createTransport(
        appServer,
        options.credentialMode.type === 'provided' ? options.credentialMode.capability : undefined
      );
    }

    if (transport && !shutdownSignal.requested && options.credentialMode.type === 'handoff') {
      publishedHandoff = await options.publishHandoff!(options.credentialMode.directory, {
        baseUrl: transport.url,
        capability: transport.capability,
      });
      await options.onHandoffPublished?.(publishedHandoff);
    }

    if (transport && !shutdownSignal.requested) {
      await options.onListening?.(transport, publishedHandoff);
    }
    if (!shutdownSignal.requested) await shutdownSignal.promise;
  } catch (cause) {
    hasPrimaryFailure = true;
    primaryFailure = cause;
  }

  const shutdown = new AggregateProductionShutdown({
    ingress: transport
      ? [{ name: 'App Server HTTP transport ingress', close: () => transport!.quiesce() }]
      : [],
    product: appServer ? [{ name: 'AppServer', close: () => appServer!.close() }] : [],
    edge: [
      ...(transport
        ? [{ name: 'App Server HTTP transport', close: () => transport!.close() }]
        : []),
      ...(publishedHandoff
        ? [
            {
              name: 'App Server capability handoff',
              close: () => options.cleanupHandoff!(publishedHandoff!),
            },
          ]
        : []),
    ],
  });

  try {
    await finishComposition(hasPrimaryFailure, primaryFailure, shutdown);
  } finally {
    shutdownSignal.dispose();
  }
}

export type ViteServerOwner = {
  listen(): Promise<unknown>;
  close(): Promise<void>;
  printUrls?(): void;
};

export type WebDevCliCompositionOptions = {
  readonly signalSource: ShutdownSignalSource;
  readonly createAppServer: () => Promise<OwnedAppServer>;
  readonly createTransport: (appServer: AppServerClient) => Promise<AppServerHttpTransport>;
  readonly createVite: (transport: AppServerHttpTransport) => Promise<ViteServerOwner>;
  readonly onListening?: (
    transport: AppServerHttpTransport,
    vite: ViteServerOwner
  ) => void | Promise<void>;
};

export async function runWebDevCliComposition(options: WebDevCliCompositionOptions): Promise<void> {
  let appServer: OwnedAppServer | undefined;
  let transport: AppServerHttpTransport | undefined;
  let vite: ViteServerOwner | undefined;
  let hasPrimaryFailure = false;
  let primaryFailure: unknown;
  const shutdownSignal = createShutdownSignalWaiter(options.signalSource, false);

  try {
    if (!shutdownSignal.requested) appServer = await options.createAppServer();
    if (appServer && !shutdownSignal.requested) {
      transport = await options.createTransport(appServer);
    }
    if (transport && !shutdownSignal.requested) vite = await options.createVite(transport);
    if (vite && !shutdownSignal.requested) await vite.listen();
    if (transport && vite && !shutdownSignal.requested) {
      await options.onListening?.(transport, vite);
    }
    if (!shutdownSignal.requested) await shutdownSignal.promise;
  } catch (cause) {
    hasPrimaryFailure = true;
    primaryFailure = cause;
  }

  const shutdown = new AggregateProductionShutdown({
    ingress: transport
      ? [{ name: 'App Server HTTP transport ingress', close: () => transport!.quiesce() }]
      : [],
    product: appServer ? [{ name: 'AppServer', close: () => appServer!.close() }] : [],
    edge: [
      ...(transport
        ? [{ name: 'App Server HTTP transport', close: () => transport!.close() }]
        : []),
      ...(vite ? [{ name: 'Vite', close: () => vite!.close() }] : []),
    ],
  });

  try {
    await finishComposition(hasPrimaryFailure, primaryFailure, shutdown);
  } finally {
    shutdownSignal.dispose();
  }
}

async function settlePhase(
  phase: ProductionResourceShutdownError['phase'],
  tasks: readonly ShutdownTask[],
  failures: ProductionResourceShutdownError[]
): Promise<void> {
  const results = await Promise.allSettled(
    tasks.map(async (task) => await Promise.resolve().then(() => task.close()))
  );

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') return;
    const task = tasks[index];
    if (!task) return;
    for (const cause of flattenAggregate(result.reason)) {
      failures.push(new ProductionResourceShutdownError(phase, task.name, cause));
    }
  });
}

async function finishComposition(
  hasPrimaryFailure: boolean,
  primaryFailure: unknown,
  shutdown: AggregateProductionShutdown
): Promise<void> {
  let hasShutdownFailure = false;
  let shutdownFailure: unknown;

  try {
    await shutdown.close();
  } catch (cause) {
    hasShutdownFailure = true;
    shutdownFailure = cause;
  }

  if (hasPrimaryFailure && hasShutdownFailure) {
    throw new AggregateError(
      [primaryFailure, ...flattenAggregate(shutdownFailure)],
      'Production composition and shutdown failed'
    );
  }
  if (hasPrimaryFailure) throw primaryFailure;
  if (hasShutdownFailure) throw shutdownFailure;
}

function createShutdownSignalWaiter(
  source: ShutdownSignalSource,
  acceptParentMessage: boolean
): { readonly promise: Promise<void>; readonly requested: boolean; dispose(): void } {
  let settled = false;
  let disposed = false;
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    source.off('SIGINT', shutdown);
    source.off('SIGTERM', shutdown);
    if (acceptParentMessage) source.off('message', shutdownFromParent);
  };
  const shutdown = () => {
    if (settled) return;
    settled = true;
    resolvePromise();
  };
  const shutdownFromParent = (message: unknown) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'shutdown'
    ) {
      shutdown();
    }
  };

  source.on('SIGINT', shutdown);
  source.on('SIGTERM', shutdown);
  if (acceptParentMessage) source.on('message', shutdownFromParent);

  return {
    promise,
    get requested() {
      return settled;
    },
    dispose,
  };
}

function assertHandoffDependencies(options: AppServerCliCompositionOptions): void {
  if (
    options.credentialMode.type === 'handoff' &&
    (!options.publishHandoff || !options.cleanupHandoff)
  ) {
    throw new Error('Handoff mode requires publish and cleanup functions');
  }
}

function flattenAggregate(cause: unknown): readonly unknown[] {
  if (!(cause instanceof AggregateError)) return [cause];
  return cause.errors.flatMap((nested) => flattenAggregate(nested));
}

function readErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
