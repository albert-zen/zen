import type { ZenXThreadTitleCoordinator } from "../../src/main/thread-title-coordinator.js";
import type {
  ThreadTitleProjection,
  ThreadTitleSnapshot,
} from "../../src/main/thread-title-types.js";

const TITLE_STAGE_TIMEOUT_MS = 5_000;

export async function waitForTitleStatus(
  titles: ZenXThreadTitleCoordinator,
  threadId: string,
  status: ThreadTitleProjection["status"],
  stage: string,
): Promise<void> {
  let latest: ThreadTitleProjection | undefined;
  let dispose = (): void => undefined;
  let timer: NodeJS.Timeout | undefined;
  let settled = false;

  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      dispose();
      if (error === undefined) resolve();
      else reject(error);
    };
    const inspect = (snapshot: ThreadTitleSnapshot): void => {
      latest = snapshot[threadId];
      if (latest?.status === status) finish();
    };

    dispose = titles.onChange(inspect);
    try {
      inspect(titles.snapshot());
    } catch (error) {
      finish(
        new Error(
          `Title state observation failed during ${stage}: ${describeError(error)}`,
        ),
      );
      return;
    }
    if (settled) return;
    timer = setTimeout(() => {
      finish(
        new Error(
          `Timed out after ${String(
            TITLE_STAGE_TIMEOUT_MS,
          )}ms during ${stage}: waiting for title status ${status} on ${threadId}; last projection=${JSON.stringify(
            latest ?? null,
          )}`,
        ),
      );
    }, TITLE_STAGE_TIMEOUT_MS);
  });
}

export async function waitForTitleStage<T>(
  work: Promise<T>,
  stage: string,
  diagnostics: () => string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `Timed out after ${String(
                TITLE_STAGE_TIMEOUT_MS,
              )}ms during ${stage}: ${diagnostics()}`,
            ),
          );
        }, TITLE_STAGE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
