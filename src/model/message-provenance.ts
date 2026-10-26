import { committedModelContentItemId } from "../context-materialization.js";
import { modelMessageSource, type ModelMessage } from "../model.js";

/** Passive serializer identity, never matched by text or persisted as history. */
export interface SerializedMessageSource {
  itemId: string;
  sourceItemIds?: string[];
  container: "messages" | "input";
  index: number;
}
export function serializedMessageSource(
  message: object,
  container: SerializedMessageSource["container"],
  index: number,
): SerializedMessageSource[] {
  if ((message as ModelMessage).role !== "user") return [];
  const source = modelMessageSource(message as ModelMessage);
  const committed = committedModelContentItemId(message);
  const itemId =
    committed ?? (source?.itemIds.length === 1 ? source.itemIds[0] : undefined);
  return itemId === undefined
    ? []
    : [
        {
          itemId,
          ...(source &&
          (source.itemIds.length !== 1 || source.itemIds[0] !== itemId)
            ? { sourceItemIds: [...source.itemIds] }
            : {}),
          container,
          index,
        },
      ];
}
