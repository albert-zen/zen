import type { ThreadSnapshot } from "../../../../src/app-server.js";
import { previewFromInputMessage } from "../../../../src/item.js";
import { meaningfulTitleSource } from "./thread-title-coordinator.js";
import type {
  Thread,
  ServerNotificationMethod,
  ServerNotificationParams,
} from "../protocol-client/index.js";

const MAX_OBSERVED_INPUT_LENGTH = 2_000;

export interface ThreadTitleObservationPort {
  observe(threadId: string, input: string): Promise<unknown>;
  observeNativeName?(threadId: string, name: string): Promise<void>;
}

export async function observeCompletedInputTitle(
  titles: ThreadTitleObservationPort,
  method: ServerNotificationMethod,
  params: ServerNotificationParams[ServerNotificationMethod],
  warn: (message: string) => void = console.warn,
): Promise<void> {
  let threadId: string;
  let input: string;
  if (method === "zen/thread/event") {
    const { event } = params as ServerNotificationParams["zen/thread/event"];
    if (event.type !== "item_completed") return;
    threadId = event.item.threadId;
    input = previewFromInputMessage(event.item);
  } else if (method === "item/completed") {
    // Compatibility-only clients still supply the expressible user-message subset.
    const event = params as ServerNotificationParams["item/completed"];
    if (event.item.type !== "userMessage") return;
    threadId = event.threadId;
    input = event.item.content.map((content) => content.text).join("\n");
  } else return;
  input = input.slice(0, MAX_OBSERVED_INPUT_LENGTH);
  if (meaningfulTitleSource(input) === null) return;
  try {
    await titles.observe(threadId, input);
  } catch (error) {
    warn(
      `Could not observe completed input for ZenX title: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Discover external threads without selecting them in any desktop window.
 * Native resume atomically supplies canonical input plus future notifications.
 * The shared recovery observer receives that snapshot before overlap events,
 * including after reconnect; discovery does not read or observe it twice.
 */
export async function observeDiscoveredThreadTitle(
  resume: (threadId: string) => Promise<unknown>,
  thread: Pick<Thread, "id">,
  warn: (message: string) => void = console.warn,
): Promise<void> {
  try {
    await resume(thread.id);
  } catch (error) {
    warn(
      `Could not observe discovered Thread for ZenX title: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function observeThreadSnapshotTitle(
  titles: ThreadTitleObservationPort,
  snapshot: Thread | ThreadSnapshot,
): Promise<void> {
  // Snapshot names may seed missing ownership, never override a newer local fact.
  if (snapshot.name) {
    await titles.observeNativeName?.(snapshot.id, snapshot.name);
    return;
  }
  const canonical =
    "items" in snapshot ? snapshot.items : snapshot.canonicalItems;
  if (canonical !== undefined) {
    for (const item of canonical) {
      const input = previewFromInputMessage(item).slice(
        0,
        MAX_OBSERVED_INPUT_LENGTH,
      );
      if (meaningfulTitleSource(input) === null) continue;
      await titles.observe(snapshot.id, input);
      break;
    }
    return;
  }
  for (const turn of snapshot.turns) {
    for (const item of turn.items) {
      if (item.type !== "userMessage") continue;
      const input = item.content
        .map((part) => part.text)
        .join("\n")
        .slice(0, MAX_OBSERVED_INPUT_LENGTH);
      if (meaningfulTitleSource(input) === null) continue;
      await titles.observe(snapshot.id, input);
      return;
    }
  }
}
