import type { AppServerEvent } from "../../app-server.js";

export const NATIVE_THREAD_RESUME_METHOD = "zen/thread/resume";
export const NATIVE_THREAD_EVENT_METHOD = "zen/thread/event";
export const NATIVE_MODEL_CATALOG_UPDATED_METHOD = "model/catalog/updated";

export interface NativeThreadEventParams {
  processEpoch: string;
  threadId: string;
  watermark: number;
  event: AppServerEvent;
}

export function nativeEventThreadId(event: AppServerEvent): string | null {
  if (event.type === "model_catalog_updated") return null;
  return event.type === "item_completed" ? event.item.threadId : event.threadId;
}
