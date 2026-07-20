import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const DEFAULT_POLL_INTERVAL_MS = 250;
const MIN_POLL_INTERVAL_MS = 25;
const MAX_POLL_INTERVAL_MS = 10_000;

export type ShutdownFileWatcher = {
  readonly requested: boolean;
  dispose(): void;
};

export type ShutdownFileWatcherOptions = {
  readonly markerPath?: string;
  readonly onShutdown: () => void;
  readonly pollIntervalMs?: number;
};

/**
 * Polls an optional process-local marker without keeping Node alive. The marker
 * is intentionally only a shutdown request; the caller owns graceful cleanup.
 */
export function watchShutdownFile(options: ShutdownFileWatcherOptions): ShutdownFileWatcher {
  if (options.markerPath === undefined) {
    return { requested: false, dispose: () => undefined };
  }

  const markerPath = validateMarkerPath(options.markerPath);
  const pollIntervalMs = validatePollInterval(options.pollIntervalMs);
  assertExistingMarkerIsFile(markerPath);
  let requested = false;
  let disposed = false;
  const timer = setInterval(() => {
    if (requested || disposed || !isMarkerFilePresent(markerPath)) return;

    requested = true;
    dispose();
    options.onShutdown();
  }, pollIntervalMs);
  timer.unref();

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
  };

  return {
    get requested() {
      return requested;
    },
    dispose,
  };
}

function validateMarkerPath(value: string): string {
  if (!value.trim()) throw new Error('Shutdown marker path must not be empty');
  if (value.includes('\0'))
    throw new Error('Shutdown marker path must not contain a null character');
  if (!isAbsolute(value)) throw new Error('Shutdown marker path must be an absolute path');
  return value;
}

function validatePollInterval(value: number | undefined): number {
  const resolved = value ?? DEFAULT_POLL_INTERVAL_MS;
  if (
    !Number.isInteger(resolved) ||
    resolved < MIN_POLL_INTERVAL_MS ||
    resolved > MAX_POLL_INTERVAL_MS
  ) {
    throw new Error(
      `Shutdown marker poll interval must be an integer from ${MIN_POLL_INTERVAL_MS} to ${MAX_POLL_INTERVAL_MS}ms`
    );
  }
  return resolved;
}

function assertExistingMarkerIsFile(markerPath: string): void {
  if (!isMarkerFilePresent(markerPath)) return;
}

function isMarkerFilePresent(markerPath: string): boolean {
  try {
    const stats = statSync(markerPath);
    if (!stats.isFile())
      throw new Error(`Shutdown marker path must refer to a file: ${markerPath}`);
    return true;
  } catch (cause) {
    if (isMissingPathError(cause)) return false;
    throw cause;
  }
}

function isMissingPathError(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause.code === 'ENOENT' || cause.code === 'ENOTDIR')
  );
}
