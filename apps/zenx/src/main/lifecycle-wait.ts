/** A bounded observer failed to confirm completion; the operation remains live. */
export class LifecycleWaitUnconfirmedError extends Error {
  constructor(
    readonly phase: string,
    readonly timeoutMs: number,
    readonly completion: Promise<unknown>,
  ) {
    super(
      `${phase} did not confirm completion within ${timeoutMs}ms; termination is unconfirmed. Pending operations and launch leases are not released, and no replacement is started.`,
    );
    this.name = "LifecycleWaitUnconfirmedError";
  }
}

/** Bounds readiness/shutdown reporting, never settles or cancels its source. */
export function waitForLifecycle<T>(
  operation: Promise<T>,
  phase: string,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new LifecycleWaitUnconfirmedError(phase, timeoutMs, operation)),
      timeoutMs,
    );
    operation.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
