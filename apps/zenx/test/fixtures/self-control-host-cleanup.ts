/** Test-only ownership cleanup; a failed Stop must never be reported as success. */
export async function cleanupSelfControlHostFixture(options: {
  directory: string;
  stop(): Promise<void>;
  release(): Promise<void>;
  closeCapabilities(): Promise<void>;
  removeDirectory(): Promise<void>;
  report(message: string, error?: unknown): void;
}): Promise<void> {
  const failures: Error[] = [];
  const attempt = async (
    stage: string,
    operation: () => Promise<void>,
  ): Promise<boolean> => {
    try {
      await operation();
      return true;
    } catch (cause) {
      failures.push(new Error(stage, { cause }));
      return false;
    }
  };

  // Give native cleanup its full owned join before the fallback release.
  // Releasing earlier could end the child during its initial identity snapshot.
  const stopped = await attempt("Host Stop failed", options.stop);
  await attempt("Fixture fallback release failed", options.release);
  await attempt("Fixture capabilities close failed", options.closeCapabilities);
  if (stopped) {
    await attempt("Fixture directory removal failed", options.removeDirectory);
  } else {
    // Removing the directory could erase release before a still-live child sees
    // it. Keep this synthetic fixture and its evidence when exit is unconfirmed.
    options.report(
      `Retained synthetic self-control fixture after unconfirmed Host Stop: ${options.directory}`,
    );
  }
  if (failures.length > 0) {
    const failure = new AggregateError(
      failures,
      "Self-control Host fixture cleanup failed",
    );
    options.report(failure.message, failure);
    throw failure;
  }
}
