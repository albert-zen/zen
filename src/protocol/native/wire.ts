import type { AppServerEvent } from "../../app-server.js";
import type {
  CreateChildThreadInput,
  ForkThreadInput,
  ThreadSnapshot,
  QueuedInputAdmission,
} from "../../app-server.js";
import type { UserInput, UserInputPart } from "../../item.js";
import type { ImageMediaType } from "../../attachment-ref.js";
import type { SkillReference } from "../../skill-input.js";

/** Wire-only bytes are imported into a canonical AttachmentRef by the Host. */
export interface NativeImageBytesInput {
  type: "image_bytes";
  mediaType: ImageMediaType;
  dataBase64: string;
}
export type NativeUserInputPart =
  UserInputPart | SkillReference | NativeImageBytesInput;
export const NATIVE_QUEUED_INPUT_ADMISSION_CAPABILITY =
  "queued-input-admission-v1";
export const NATIVE_INLINE_IMAGE_INPUT_CAPABILITY = "inline-image-input-v1";

export const NATIVE_TURN_WAKE_METHOD = "zen/turn/wake";
export type NativeHostWakeupParams = import("../../item.js").HostWakeupInput & {
  threadId: string;
  mode?: "start" | "steer" | "queue";
  expectedTurnId?: string;
  requireUnarchived?: boolean;
};
export interface NativeHostWakeupResult {
  turnId?: string;
  mode: "start" | "steer" | "queue";
  queued?: boolean;
}

export interface NativeTurnSendParams {
  threadId: string;
  /** Omitted means soft steer active work, or start when idle. */
  mode?: "start" | "queue" | "batch-next" | "steer" | "replace";
  expectedTurnId?: string;
  clientUserMessageId: string;
  input: readonly NativeUserInputPart[];
  /** Native-only canonical admission requirement; omitted preserves defaults. */
  requireUnarchived?: boolean;
}
export interface NativeTurnSendResult {
  turnId?: string;
  interruptedTurnId?: string;
  admission?: QueuedInputAdmission;
}
/** Older Hosts reject this method instead of ignoring a new admission field. */
export const NATIVE_TURN_SEND_UNARCHIVED_METHOD = "zen/turn/send-unarchived";

export const NATIVE_INITIALIZE_METHOD = "zen/initialize";
export const NATIVE_THREAD_READ_METHOD = "zen/thread/read";
export const NATIVE_THREAD_FORK_METHOD = "zen/thread/fork";
export type NativeForkThreadParams = ForkThreadInput;
export interface NativeForkThreadResult {
  thread: ThreadSnapshot;
}
export const NATIVE_THREAD_CREATE_CHILD_METHOD = "zen/thread/create-child";
export type NativeCreateChildThreadParams = CreateChildThreadInput;
export interface NativeCreateChildThreadResult {
  thread: ThreadSnapshot;
}
export const NATIVE_QUEUE_EDIT_METHOD = "zen/thread/queue/edit";
export interface NativeQueueEditParams {
  threadId: string;
  queuedItemId: string;
  clientId: string;
  expectedRevision: number;
  editId: string;
  input: UserInput;
}
export type NativeQueueEditResult =
  import("../../app-server.js").QueuedEditResult;

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

/** Host-only provenance fields, never exposed as model tool arguments. */
export interface NativeThreadMessageParams {
  threadId: string;
  sourceThreadId: string;
  sourceToolCallId: string;
  sourceCallId: string;
  text: string;
  messageType?: "guidance" | "follow_up" | "replacement";
}
export type NativeThreadMessageResult = Awaited<
  ReturnType<import("../../app-server.js").ZenAppServer["sendThreadMessage"]>
>;
export const NATIVE_THREAD_MESSAGE_METHOD = "zen/thread/message";

export const NATIVE_THREAD_DELETE_METHOD = "zen/thread/delete";
export const NATIVE_THREAD_DELETED_LIST_METHOD = "zen/thread/deleted/list";
export const NATIVE_THREAD_RESTORE_METHOD = "zen/thread/restore";
export interface NativeThreadDeleteParams {
  threadId: string;
  expectedLastItemId: string;
}
export interface NativeThreadRestoreParams {
  threadId: string;
  deletionItemId: string;
}
export type NativeThreadDeleteResult =
  import("../../app-server.js").DeleteThreadResult;
export type DeletedThreadSummary =
  import("../../app-server.js").DeletedThreadSummary;
export interface NativeThreadDeletedListResult {
  data: DeletedThreadSummary[];
}
export interface NativeThreadRestoreResult {
  thread: ThreadSnapshot;
}

export const NATIVE_THREAD_ORIGINAL_READ_METHOD = "zen/thread/original/read";
export type NativeOriginalHistoryParams =
  import("../../thread-history.js").OriginalHistoryOptions & {
    threadId: string;
  };
export type NativeOriginalHistoryResult =
  import("../../thread-history.js").OriginalHistoryPage;
