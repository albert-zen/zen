import type { AppServerEvent } from "../../app-server.js";
import type {
  CreateChildThreadInput,
  ThreadSnapshot,
} from "../../app-server.js";
import type { UserInputPart } from "../../item.js";
import type { SkillReference } from "../../skill-input.js";

export interface NativeTurnSendParams {
  threadId: string;
  mode: "start" | "queue" | "batch-next" | "steer" | "replace";
  expectedTurnId?: string;
  clientUserMessageId: string;
  input: readonly (UserInputPart | SkillReference)[];
  /** Native-only canonical admission requirement; omitted preserves defaults. */
  requireUnarchived?: boolean;
}
export interface NativeTurnSendResult {
  turnId?: string;
  interruptedTurnId?: string;
}
/** Older Hosts reject this method instead of ignoring a new admission field. */
export const NATIVE_TURN_SEND_UNARCHIVED_METHOD = "zen/turn/send-unarchived";

export const NATIVE_INITIALIZE_METHOD = "zen/initialize";
export const NATIVE_THREAD_READ_METHOD = "zen/thread/read";
export const NATIVE_THREAD_CREATE_CHILD_METHOD = "zen/thread/create-child";
export type NativeCreateChildThreadParams = CreateChildThreadInput;
export interface NativeCreateChildThreadResult {
  thread: ThreadSnapshot;
}
export const NATIVE_QUEUE_CANCEL_METHOD = "zen/thread/queue/cancel";
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
