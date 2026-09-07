import path from "node:path";

import type { AttachmentRef, AttachmentStore } from "./attachment.js";
import { contentFromUserMessage } from "./item.js";
import type { ThreadJournal } from "./journal.js";
import type { ModelTool } from "./model.js";
import type {
  ToolExecutionResult,
  ToolInvocation,
  ToolRuntime,
} from "./tool.js";

/** Builtin projection from an immutable stored image to the next model sample. */
export class ViewImageToolRuntime implements ToolRuntime {
  readonly name = "view_image";
  readonly requiredModelInputModalities = ["image"] as const;
  readonly specification: ModelTool = {
    name: this.name,
    description:
      "View an image from a local file path or an AttachmentRef already referenced by the current thread.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Image path, resolved from the thread working directory.",
        },
        attachment: {
          type: "object",
          description: "An AttachmentRef from the current thread.",
          properties: {
            type: { const: "attachment" },
            sha256: { type: "string" },
            mediaType: {
              enum: ["image/png", "image/jpeg", "image/gif", "image/webp"],
            },
            byteLength: { type: "integer" },
            width: { type: "integer" },
            height: { type: "integer" },
          },
          required: [
            "type",
            "sha256",
            "mediaType",
            "byteLength",
            "width",
            "height",
          ],
          additionalProperties: false,
        },
      },
      oneOf: [{ required: ["path"] }, { required: ["attachment"] }],
      additionalProperties: false,
    },
  };

  readonly #attachments: AttachmentStore;
  readonly #journal: Pick<ThreadJournal, "read">;

  constructor(options: {
    attachments: AttachmentStore;
    journal: Pick<ThreadJournal, "read">;
  }) {
    this.#attachments = options.attachments;
    this.#journal = options.journal;
  }

  async execute(invocation: ToolInvocation): Promise<ToolExecutionResult> {
    const imagePath = invocation.arguments.path;
    const attachment = invocation.arguments.attachment;
    if ((typeof imagePath === "string") === (attachment !== undefined)) {
      throw new Error("view_image requires exactly one of path or attachment");
    }

    let ref: AttachmentRef;
    if (typeof imagePath === "string") {
      if (imagePath.length === 0)
        throw new Error("Image path must not be empty");
      ref = await this.#attachments.importLocalImage(
        path.resolve(invocation.cwd, imagePath),
      );
    } else {
      if (invocation.threadId === undefined) {
        throw new Error("view_image requires a current thread");
      }
      ref = requireAttachmentRef(attachment);
      const referenced = referencedImages(
        await this.#journal.read(invocation.threadId),
      );
      if (!referenced.some((candidate) => sameAttachment(candidate, ref))) {
        throw new Error(
          `Attachment ${ref.sha256} is not referenced by the current thread`,
        );
      }
      await this.#attachments.read(ref);
    }

    return {
      output: `Viewed image ${ref.sha256} (${String(ref.width)}x${String(ref.height)}, ${ref.mediaType})`,
      exitCode: 0,
      modelContent: [{ type: "image", attachment: ref }],
    };
  }
}

function referencedImages(
  items: Awaited<ReturnType<Pick<ThreadJournal, "read">["read"]>>,
): AttachmentRef[] {
  return items.flatMap((item) => {
    if (item.type === "user_message") {
      return contentFromUserMessage(item).flatMap((part) =>
        part.type === "image" ? [part.attachment] : [],
      );
    }
    if (item.type === "tool_result" && item.modelContent !== undefined) {
      return item.modelContent.flatMap((part) =>
        part.type === "image" ? [part.attachment] : [],
      );
    }
    return [];
  });
}

function requireAttachmentRef(value: unknown): AttachmentRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("attachment must be an AttachmentRef");
  }
  const ref = value as Partial<AttachmentRef>;
  if (
    ref.type !== "attachment" ||
    typeof ref.sha256 !== "string" ||
    typeof ref.mediaType !== "string" ||
    typeof ref.byteLength !== "number" ||
    typeof ref.width !== "number" ||
    typeof ref.height !== "number"
  ) {
    throw new Error("attachment must be an AttachmentRef");
  }
  return ref as AttachmentRef;
}

function sameAttachment(left: AttachmentRef, right: AttachmentRef): boolean {
  return (
    left.sha256 === right.sha256 &&
    left.mediaType === right.mediaType &&
    left.byteLength === right.byteLength &&
    left.width === right.width &&
    left.height === right.height
  );
}
