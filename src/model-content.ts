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
import type { ModelMessage } from "./model.js";

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
): ModelMessage[] {
  const supported = new Set(inputModalities ?? ["text"]);
  const project = (content: UserInput): UserInput =>
    deduplicateMediaContent(content).map((part) => {
      if (part.type === "text" || supported.has(part.type))
        return structuredClone(part);
      return { type: "text", text: mediaReceipt(part.type, part.attachment) };
    });
  return messages.map((message) => {
    if (message.role === "user" && "content" in message)
      return { ...message, content: project(message.content) };
    if (message.role === "tool" && message.modelContent !== undefined)
      return { ...message, modelContent: project(message.modelContent) };
    return structuredClone(message);
  });
}

export function mediaReceipt(kind: MediaKind, ref: AttachmentRef): string {
  return `[${kind} attachment sha256:${ref.sha256}, ${ref.mediaType}, ${String(ref.byteLength)} bytes; ${kind} input unavailable for this model]`;
}

/** Collapse only identical media, keeping explicit text and first-occurrence order. */
export function deduplicateMediaContent(content: UserInput): UserInput {
  const seen = new Set<string>();
  return content.filter((part) => {
    if (part.type === "text") return true;
    const key = `${part.type}:${part.attachment.sha256}:${part.attachment.mediaType}:${String(part.attachment.byteLength)}:${String(part.attachment.width)}:${String(part.attachment.height)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
