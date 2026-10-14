import { AppServerError, type ZenAppServer } from "../../app-server.js";
import {
  AttachmentStoreError,
  decodeMediaDataUri,
  MAX_IMAGE_BYTES,
} from "../../attachment.js";
import { validateUserInput, type UserInputPart } from "../../item.js";
import type { SkillReference } from "../../skill-input.js";
import { isRecord } from "../codex/wire.js";
import type { NativeImageBytesInput } from "./wire.js";

// New inline-input budgets; canonical-only inputs keep their existing contract.
export const MAX_NATIVE_INPUT_IMAGES = 16;
export const MAX_NATIVE_INPUT_IMAGE_BYTES = 32 * 1024 * 1024;

export async function prepareNativeInput(
  parts: readonly unknown[],
  appServer: ZenAppServer,
): Promise<(UserInputPart | SkillReference)[]> {
  let images = 0;
  let bytes = 0;
  let inline = false;
  const prepared = parts.map(
    (part): UserInputPart | SkillReference | NativeImageBytesInput => {
      if (!isRecord(part))
        throw new AppServerError("invalid_input", "Invalid input part");
      if (part.skillSource !== undefined)
        throw new AppServerError(
          "invalid_input",
          "Skill provenance is Host-owned",
        );
      if (
        part.type === "skill" &&
        typeof part.id === "string" &&
        part.id.length > 0
      )
        return { type: "skill", id: part.id };
      if (part.type === "image_bytes") {
        inline = true;
        images++;
        if (
          Object.keys(part).some(
            (key) => !["type", "mediaType", "dataBase64"].includes(key),
          ) ||
          typeof part.mediaType !== "string" ||
          !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
            part.mediaType,
          ) ||
          typeof part.dataBase64 !== "string"
        )
          throw new AppServerError(
            "invalid_input",
            "Inline images require an image MIME and base64 bytes only",
          );
        const encoded = part.dataBase64;
        // Check length before running a regexp, copying a data URI, or decoding.
        if (encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
          throw new AppServerError(
            "attachment_too_large",
            "Inline image exceeds the image byte limit",
          );
        const padding = encoded.endsWith("==")
          ? 2
          : encoded.endsWith("=")
            ? 1
            : 0;
        const decodedLength = Math.floor(((encoded.length - padding) * 3) / 4);
        if (decodedLength > MAX_IMAGE_BYTES)
          throw new AppServerError(
            "attachment_too_large",
            "Inline image exceeds the image byte limit",
          );
        bytes += decodedLength;
        return {
          type: "image_bytes",
          mediaType: part.mediaType as NativeImageBytesInput["mediaType"],
          dataBase64: encoded,
        };
      }
      validateUserInput([part], "input");
      const input = structuredClone(part) as unknown as UserInputPart;
      if (input.type === "image") {
        bytes += input.attachment.byteLength;
        images++;
      }
      return input;
    },
  );
  if (
    inline &&
    (images > MAX_NATIVE_INPUT_IMAGES || bytes > MAX_NATIVE_INPUT_IMAGE_BYTES)
  )
    throw new AppServerError(
      "attachment_too_large",
      "Inline input exceeds 16 images or 32 MiB of image bytes",
    );
  const input: (UserInputPart | SkillReference)[] = [];
  for (const part of prepared) {
    if (part.type !== "image_bytes") {
      input.push(part);
      continue;
    }
    try {
      const decoded = decodeMediaDataUri(
        `data:${part.mediaType};base64,${part.dataBase64}`,
      );
      input.push({
        type: "image",
        attachment: await appServer.importImageBytes(
          decoded.bytes,
          decoded.mediaType,
        ),
      });
    } catch (error) {
      if (error instanceof AttachmentStoreError)
        throw new AppServerError(error.code, error.message);
      throw error;
    }
  }
  return input;
}
