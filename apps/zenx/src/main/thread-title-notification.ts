import type {
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
