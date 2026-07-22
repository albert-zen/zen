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

export type BoundedCloseOptions = {
  readonly attempts?: number;
  readonly attemptTimeoutMs?: number;
  readonly onFailure?: (cause: unknown, attempt: number) => void;
};

const defaultCloseAttemptTimeoutMs = 5_000;

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
        await closeWithBoundedRetry(() => this.close(), { attempts: 2 });
      } catch (shutdownCause) {
        throw new AggregateError([cause, shutdownCause], 'Desktop startup and shutdown failed', {
          cause: shutdownCause,
        });
      }
      throw cause;
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const attempt = this.closeResources();
    this.closePromise = attempt;
    void attempt.catch(() => {
      if (this.closePromise === attempt) this.closePromise = undefined;
    });
    return attempt;
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

export async function closeWithBoundedRetry(
  close: () => Promise<void>,
  options: BoundedCloseOptions = {}
): Promise<void> {
  const attempts = options.attempts ?? 2;
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error('Bounded close attempts must be a positive integer');
  }
  const attemptTimeoutMs = options.attemptTimeoutMs ?? defaultCloseAttemptTimeoutMs;
  if (!Number.isFinite(attemptTimeoutMs) || attemptTimeoutMs <= 0) {
    throw new Error('Bounded close attempt timeout must be positive');
  }

  const failures: unknown[] = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await closeWithDeadline(close, attemptTimeoutMs);
      return;
    } catch (cause) {
      failures.push(cause);
      options.onFailure?.(cause, attempt);
    }
  }
  throw new AggregateError(failures, `Production shutdown failed after ${attempts} attempts`);
}

async function closeWithDeadline(close: () => Promise<void>, timeoutMs: number): Promise<void> {
  const operation = Promise.resolve().then(close);
  void operation.catch(() => undefined);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Production shutdown attempt timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    timeout.unref?.();
  });
  try {
    await Promise.race([operation, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
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
