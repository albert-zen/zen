import { createHash } from "node:crypto";

import type { AttachmentRef } from "../../../../src/attachment.js";
import {
  OpenAiCompatibleModel,
  OpenAiCompatibleModelError,
} from "../../../../src/model/openai-compatible.js";

export type ImageCapabilityProbeOutcome =
  "supported" | "unsupported" | "inconclusive";

// A valid 1x1 transparent PNG. It is intentionally tiny because a probe is a
// user-triggered real model request and may incur Provider cost.
const PROBE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const PROBE_REF: AttachmentRef = Object.freeze({
  type: "attachment",
  sha256: createHash("sha256").update(PROBE_PNG).digest("hex"),
  mediaType: "image/png",
  byteLength: PROBE_PNG.byteLength,
  width: 1,
  height: 1,
});

export async function probeOpenAiCompatibleImage(options: {
  baseUrl: string;
  apiKey: string;
  provider: string;
  model: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}): Promise<ImageCapabilityProbeOutcome> {
  const controller = new AbortController();
  const signal = options.signal ?? controller.signal;
  const adapter = new OpenAiCompatibleModel({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    provider: options.provider,
    defaultParams: { max_tokens: 1 },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    attachments: {
      read: async (ref) => {
        if (ref.sha256 !== PROBE_REF.sha256)
          throw new Error("Unknown probe image");
        return PROBE_PNG;
      },
    },
  });
  try {
    for await (const _event of adapter.stream({
      model: options.model,
      reasoningEffort: "medium",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Reply OK." },
            { type: "image", attachment: PROBE_REF },
          ],
        },
      ],
      tools: [],
      signal,
    })) {
      // Consume the real adapter stream through its terminal marker.
    }
    return "supported";
  } catch (error) {
    return isExplicitImageUnsupported(error) ? "unsupported" : "inconclusive";
  }
}

function isExplicitImageUnsupported(error: unknown): boolean {
  if (!(error instanceof OpenAiCompatibleModelError) || error.kind !== "http") {
    return false;
  }
  if (
    error.status === 401 ||
    error.status === 402 ||
    error.status === 403 ||
    error.status === 404 ||
    error.status === 408 ||
    error.status === 409 ||
    error.status === 429 ||
    (error.status !== undefined && error.status >= 500)
  ) {
    return false;
  }
  return error.explicitlyRejectsImageInput;
}
