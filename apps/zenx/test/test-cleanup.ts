/** Attempt every teardown step without replacing the test's original failure. */
export async function finishTestCleanup(
  steps: Array<() => void | Promise<void>>,
  errors: unknown[] = [],
): Promise<void> {
  const failures = [...errors];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Test and cleanup failures");
}
