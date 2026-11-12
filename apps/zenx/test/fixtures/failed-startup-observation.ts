/** Test-only evidence collection. Never convert a failed acceptance into a pass. */
export function createFailedStartupObserver({
  enabled,
  budgetMs = 10000,
  now = Date.now,
  sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  log = console.info,
}: {
  enabled: boolean;
  budgetMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}) {
  // Shared by the file, so two slow startups cannot each add an unbounded wait.
  let remainingMs = budgetMs;
  const report = (message: string) => {
    try {
      log(message);
    } catch {
      /* Diagnostic logging cannot replace acceptance failure. */
    }
  };
  return async <T>(
    stage: string,
    acceptance: () => Promise<T>,
    observe: () => { ready: boolean; [key: string]: unknown },
  ): Promise<T> => {
    const started = now();
    try {
      return await acceptance();
    } catch (failure) {
      if (enabled) {
        const observationStarted = now();
        const deadline = observationStarted + remainingMs;
        try {
          for (;;) {
            const snapshot = observe();
            const elapsedMs = now() - started;
            const exhausted = now() >= deadline;
            report(
              `[Shell failed startup] ${JSON.stringify({
                stage,
                elapsedMs,
                originalFailure: String(failure),
                ...snapshot,
                outcome: snapshot.ready
                  ? "ready_after_failure"
                  : exhausted
                    ? "observation_deadline"
                    : "waiting",
              })}`,
            );
            if (snapshot.ready || exhausted) break;
            await sleep(Math.min(1000, Math.max(0, deadline - now())));
          }
        } catch (error) {
          report(
            `[Shell failed startup] ${JSON.stringify({
              stage,
              elapsedMs: now() - started,
              observationError: String(error),
            })}`,
          );
        } finally {
          remainingMs = Math.max(0, remainingMs - (now() - observationStarted));
        }
      }
      throw failure;
    }
  };
}
