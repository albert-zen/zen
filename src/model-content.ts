import {
  decodeMediaDataUri,
  validateAttachmentRef,
  type AttachmentRef,
  type AttachmentStore,
} from "./attachment.js";
import {
  contentFromUserMessage,
  type CanonicalItem,
  type UserInput,
  type UserInputPart,
} from "./item.js";
import { copyModelMessageContextCategory, type ModelMessage } from "./model.js";
import { deduplicateMediaContent } from "./media-content.js";

export { deduplicateMediaContent } from "./media-content.js";

export type MediaKind = "image" | "audio";
export interface CodeMediaOutput {
  type: MediaKind;
  value: unknown;
}

export class AttachmentNotReferencedError extends Error {}

/** Host injection: callers supply the current thread's canonical Items at conversion time. */
export function createMediaOutputConverter(attachments: AttachmentStore) {
  return async (
    outputs: readonly CodeMediaOutput[],
    items: readonly CanonicalItem[] = [],
  ): Promise<UserInput> => {
    const content: UserInputPart[] = [];
    for (const output of outputs)
      content.push(
        ...(await resolveCodeMedia(
          output.type,
          output.value,
          attachments,
          items,
        )),
      );
    return deduplicateMediaContent(content);
  };
}

/** Imports explicit guest media through the existing store; never reads a path or fetches a URL. */
export async function resolveCodeMedia(
  kind: MediaKind,
  value: unknown,
  attachments: AttachmentStore,
  items: readonly CanonicalItem[] = [],
): Promise<UserInput> {
  if (kind !== "image" && kind !== "audio")
    throw new Error("Unsupported media output kind");
  let ref: AttachmentRef;
  const object = record(value);
  const candidate =
    object?.type === "attachment" ? object : record(object?.attachment);
  if (candidate !== undefined) {
    ref = candidate as unknown as AttachmentRef;
    validateAttachmentRef(ref);
    requireKind(ref.mediaType, kind);
    if (
      !referencedAttachments(items).some((allowed) => sameRef(allowed, ref))
    ) {
      throw new AttachmentNotReferencedError(
        `Attachment ${ref.sha256} is not referenced by the current thread`,
      );
    }
    await attachments.read(ref);
  } else {
    let dataUri: string;
    if (typeof value === "string") dataUri = value;
    else if (object !== undefined && typeof object[`${kind}_url`] === "string")
      dataUri = object[`${kind}_url`] as string;
    else if (
      object?.type === kind &&
      typeof object.data === "string" &&
      typeof object.mimeType === "string"
    )
      dataUri = `data:${object.mimeType};base64,${object.data}`;
    else
      throw new Error(
        `${kind} requires a current-thread AttachmentRef, base64 data URI, or MCP content block; local paths must use view_image`,
      );
    const decoded = decodeMediaDataUri(dataUri);
    requireKind(decoded.mediaType, kind);
    ref = await attachments.importBytes(decoded.bytes, decoded.mediaType);
  }
  return [{ type: kind, attachment: structuredClone(ref) }];
}

/** Request-only projection. Unknown modalities conservatively send textual references. */
export function projectModelMessages(
  messages: readonly ModelMessage[],
  inputModalities?: readonly string[] | null,
  onMediaProjected?: (source: object, projected: object) => void,
  budget: MediaProjectionBudget | null = DEFAULT_MEDIA_PROJECTION_BUDGET,
): ModelMessage[] {
  const supported = new Set(inputModalities ?? ["text"]);
  const project = (content: UserInput): UserInput =>
    deduplicateMediaContent(content).map((part) => {
      if (part.type === "text" || supported.has(part.type)) {
        const projected = structuredClone(part);
        if (part.type !== "text") onMediaProjected?.(part, projected);
        return projected;
      }
      return { type: "text", text: mediaReceipt(part.type, part.attachment) };
    });
  const projectedMessages = messages.map((message) => {
    const projected: ModelMessage =
      message.role === "user" && "content" in message
        ? { ...message, content: project(message.content) }
        : message.role === "tool" && message.modelContent !== undefined
          ? { ...message, modelContent: project(message.modelContent) }
          : structuredClone(message);
    copyModelMessageContextCategory(message, projected);
    return projected;
  });
  return budget === null
    ? projectedMessages
    : elideMediaOverBudget(projectedMessages, budget);
}

/** Request-only image allowance; older images become textual receipts. */
export interface MediaProjectionBudget {
  maxImages: number;
  maxBytes: number;
}

/**
 * Keep the newest images that fit. Audio and text are never budgeted, and the
 * newest image is always kept so a single oversized screenshot still reaches
 * the model instead of a request with no visual evidence at all.
 */
export const DEFAULT_MEDIA_PROJECTION_BUDGET: MediaProjectionBudget = {
  maxImages: 24,
  maxBytes: 8 * 1024 * 1024,
};

export function elideMediaOverBudget(
  messages: readonly ModelMessage[],
  budget: MediaProjectionBudget,
): ModelMessage[] {
  const dropped = new Set(
    imageBudgetOmissions(messages, budget).map(
      (occurrence) =>
        `${String(occurrence.message)}:${String(occurrence.part)}`,
    ),
  );
  if (dropped.size === 0) return [...messages];
  return messages.map((message, messageIndex) => {
    const parts = mediaParts(message);
    if (parts === undefined) return message;
    const next = parts.map((part, partIndex) =>
      part.type === "image" &&
      dropped.has(`${String(messageIndex)}:${String(partIndex)}`)
        ? { type: "text" as const, text: omittedMediaReceipt(part.attachment) }
        : part,
    );
    const projected = withMediaParts(message, next);
    copyModelMessageContextCategory(message, projected);
    return projected;
  });
}

/** Pure selection shared by legacy projection and committed sample preparation. */
export function imageBudgetOmissions(
  messages: readonly ModelMessage[],
  budget: MediaProjectionBudget = DEFAULT_MEDIA_PROJECTION_BUDGET,
): Array<{
  message: number;
  part: number;
  image: Extract<UserInputPart, { type: "image" }>;
}> {
  const occurrences: Array<{
    message: number;
    part: number;
    image: Extract<UserInputPart, { type: "image" }>;
  }> = [];
  messages.forEach((message, messageIndex) => {
    mediaParts(message)?.forEach((part, partIndex) => {
      if (part.type === "image")
        occurrences.push({
          message: messageIndex,
          part: partIndex,
          image: part,
        });
    });
  });
  let images = 0;
  let bytes = 0;
  const dropped: typeof occurrences = [];
  for (let index = occurrences.length - 1; index >= 0; index--) {
    const occurrence = occurrences[index];
    if (occurrence === undefined) continue;
    const fits =
      images === 0 ||
      (images + 1 <= budget.maxImages &&
        bytes + occurrence.image.attachment.byteLength <= budget.maxBytes);
    if (fits) {
      images += 1;
      bytes += occurrence.image.attachment.byteLength;
    } else {
      dropped.push(occurrence);
    }
  }
  return dropped.reverse();
}

function mediaParts(
  message: ModelMessage,
): readonly UserInputPart[] | undefined {
  if (message.role === "user" && "content" in message) return message.content;
  if (message.role === "tool" && message.modelContent !== undefined)
    return message.modelContent;
  return undefined;
}

function withMediaParts(
  message: ModelMessage,
  parts: readonly UserInputPart[],
): ModelMessage {
  if (message.role === "user" && "content" in message)
    return { ...message, content: parts };
  if (message.role === "tool" && message.modelContent !== undefined)
    return { ...message, modelContent: parts };
  return message;
}

export function omittedMediaReceipt(ref: AttachmentRef): string {
  const size =
    ref.width !== undefined && ref.height !== undefined
      ? `${String(ref.width)}x${String(ref.height)}, `
      : "";
  return `[image ${size}${formatBytes(ref.byteLength)} omitted from this request by the image budget; pixels were not read in this sample. Retrieve the original with view_image({"attachment":${JSON.stringify(ref)}}) if needed.]`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function mediaReceipt(kind: MediaKind, ref: AttachmentRef): string {
  return `[${kind} attachment sha256:${ref.sha256}, ${ref.mediaType}, ${String(ref.byteLength)} bytes; ${kind} input unavailable for this model]`;
}

function referencedAttachments(
  items: readonly CanonicalItem[],
): AttachmentRef[] {
  return items.flatMap((item) => {
    const content =
      item.type === "user_message"
        ? contentFromUserMessage(item)
        : item.type === "tool_result"
          ? item.modelContent
          : undefined;
    return (content ?? []).flatMap((part) =>
      part.type === "text" ? [] : [part.attachment],
    );
  });
}
function sameRef(left: AttachmentRef, right: AttachmentRef): boolean {
  return (
    left.sha256 === right.sha256 &&
    left.mediaType === right.mediaType &&
    left.byteLength === right.byteLength &&
    left.width === right.width &&
    left.height === right.height
  );
}
function requireKind(mediaType: string, kind: MediaKind): void {
  if (!mediaType.startsWith(`${kind}/`))
    throw new Error(`Expected ${kind} media, received ${mediaType}`);
}
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
