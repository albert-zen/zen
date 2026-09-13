import type {
  Thread,
  ServerNotificationMethod,
  ServerNotificationParams,
} from "../protocol-client/index.js";

const MAX_OBSERVED_INPUT_LENGTH = 2_000;

export interface ThreadTitleObservationPort {
  observe(threadId: string, input: string): Promise<unknown>;
}

export async function observeCompletedUserMessageTitle(
  titles: ThreadTitleObservationPort,
  method: ServerNotificationMethod,
  params: ServerNotificationParams[ServerNotificationMethod],
  warn: (message: string) => void = console.warn,
): Promise<void> {
  if (method !== "item/completed") return;
  const event = params as ServerNotificationParams["item/completed"];
  if (event.item.type !== "userMessage") return;
  const input = event.item.content
    .map((content) => content.text)
    .join("\n")
    .slice(0, MAX_OBSERVED_INPUT_LENGTH);
  try {
    await titles.observe(event.threadId, input);
  } catch (error) {
    warn(
      `Could not observe completed user message for ZenX title: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Discover external threads without selecting them in any desktop window.
 * Resume atomically supplies the canonical snapshot plus future notifications,
 * so a first input arriving before discovery completes cannot miss naming.
 */
export async function observeDiscoveredThreadTitle(
  titles: ThreadTitleObservationPort,
  resume: (threadId: string) => Promise<Thread>,
  thread: Thread,
  warn: (message: string) => void = console.warn,
): Promise<void> {
  try {
    const snapshot = await resume(thread.id);
    await observeThreadSnapshotTitle(titles, snapshot);
  } catch (error) {
    warn(
      `Could not observe discovered Thread for ZenX title: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function observeThreadSnapshotTitle(
  titles: ThreadTitleObservationPort,
  snapshot: Thread,
): Promise<void> {
  // A snapshot is not a rename notification; preserve native names without
  // treating a potentially stale read as new naming authority.
  if (snapshot.name) return;
  for (const turn of snapshot.turns) {
    const message = turn.items.find((item) => item.type === "userMessage");
    if (message?.type !== "userMessage") continue;
    const input = message.content
      .map((part) => part.text)
      .join("\n")
      .slice(0, MAX_OBSERVED_INPUT_LENGTH);
    if (!input.trim()) continue;
    await titles.observe(snapshot.id, input);
    break;
  }
}
