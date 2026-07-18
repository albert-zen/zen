type Closable = {
  close(): void | Promise<void>;
};

type Quiesceable = Closable & {
  quiesce(): void | Promise<void>;
};

export type DesktopStartup = {
  createComposition(): Promise<Closable>;
  createTransport(composition: Closable): Promise<Quiesceable>;
  createHost(transport: Quiesceable): Promise<Quiesceable>;
  createWindow(host: Quiesceable): Promise<Closable>;
};

export type ShutdownSignalSource = {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
};

export function installShutdownSignals(
  source: ShutdownSignalSource,
  shutdown: () => void
): () => void {
  let requested = false;
  const requestShutdown = () => {
    if (requested) return;
    requested = true;
    shutdown();
  };
  source.on('SIGINT', requestShutdown);
  source.on('SIGTERM', requestShutdown);
  return () => {
    source.off('SIGINT', requestShutdown);
    source.off('SIGTERM', requestShutdown);
  };
}

/**
 * Owns the desktop edge without exposing Electron to the lifecycle contract.
 * Shutdown preserves the production ordering: stop ingress, drain product,
 * then close edge resources while retaining every failure.
 */
export class DesktopLifecycle {
  private composition?: Closable;
  private transport?: Quiesceable;
  private host?: Quiesceable;
  private window?: Closable;
  private closePromise?: Promise<void>;

  async start(startup: DesktopStartup): Promise<void> {
    try {
      this.composition = await startup.createComposition();
      this.transport = await startup.createTransport(this.composition);
      this.host = await startup.createHost(this.transport);
      this.window = await startup.createWindow(this.host);
    } catch (cause) {
      try {
        await this.close();
      } catch (shutdownCause) {
        throw new AggregateError([cause, shutdownCause], 'Desktop startup and shutdown failed', {
          cause: shutdownCause,
        });
      }
      throw cause;
    }
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeResources();
    return this.closePromise;
  }

  private async closeResources(): Promise<void> {
    const failures: unknown[] = [];
    await settle([this.transport, this.host], (resource) => resource.quiesce(), failures);
    await settle([this.composition], (resource) => resource.close(), failures);
    await settle(
      [this.transport, this.host, this.window],
      (resource) => resource.close(),
      failures
    );
    if (failures.length > 0) throw new AggregateError(failures, 'Production shutdown failed');
  }
}

async function settle<T>(
  resources: readonly (T | undefined)[],
  close: (resource: T) => void | Promise<void>,
  failures: unknown[]
): Promise<void> {
  const present = resources.filter((resource): resource is T => resource !== undefined);
  const results = await Promise.allSettled(
    present.map(async (resource) => await Promise.resolve().then(() => close(resource)))
  );
  failures.push(
    ...results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
  );
}
