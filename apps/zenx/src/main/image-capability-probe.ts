import type { AttachmentStore } from "../../../../src/attachment.js";
import { OpenAiCompatibleModel } from "../../../../src/model/openai-compatible.js";

import { OpenAiResponsesModel } from "../../../../src/model/openai-responses.js";
import { streamAuxiliaryModel } from "../../../../src/auxiliary-model.js";
import type { FileItemListStore } from "../../../../src/item-list-store.js";
import type { RuntimeTrace } from "../../../../src/trace.js";

export type ImageCapabilityProbeOutcome =
  "supported" | "unsupported" | "inconclusive";

// A valid 1x1 transparent PNG. It is intentionally tiny because a probe is a
// user-triggered real model request and may incur Provider cost.
const PROBE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

export async function probeOpenAiCompatibleImage(options: {
  trace: RuntimeTrace;
  attachments: Pick<AttachmentStore, "importBytes" | "read">;
  itemListStore: Pick<FileItemListStore, "create">;
  protocol?: "chat-completions" | "responses";
  assertDispatchAllowed?: () => void;
  baseUrl: string;
  apiKey: string;
  provider: string;
  model: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}): Promise<ImageCapabilityProbeOutcome> {
  const controller = new AbortController();
  const signal = options.signal ?? controller.signal;
  const probeRef = await options.attachments.importBytes(
    PROBE_PNG,
    "image/png",
  );
  const Adapter =
    options.protocol === "responses"
      ? OpenAiResponsesModel
      : OpenAiCompatibleModel;
  const adapter = new Adapter({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    provider: options.provider,
    defaultParams:
      options.protocol === "responses"
        ? { max_output_tokens: 1 }
        : { max_tokens: 1 },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    attachments: options.attachments,
  });
  let prepared = false;
  try {
    for await (const _event of streamAuxiliaryModel({
      adapter,
      trace: options.trace,
      itemListStore: options.itemListStore,
      purpose: "image-probe",
      onPrepared: () => {
        prepared = true;
      },
      inputModalities: ["text", "image"],
      ...(options.assertDispatchAllowed === undefined
        ? {}
        : { assertDispatchAllowed: options.assertDispatchAllowed }),
      configuration: {
        baseUrl: options.baseUrl,
        protocol: options.protocol ?? "chat-completions",
      },
      model: options.model,
      reasoningEffort: "medium",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Reply OK." },
            { type: "image", attachment: probeRef },
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
    if (!prepared) throw error;
    return isExplicitImageUnsupported(error) ? "unsupported" : "inconclusive";
  }
}

function isExplicitImageUnsupported(error: unknown): boolean {
  if (
    !(error instanceof Error) ||
    !("status" in error) ||
    typeof error.status !== "number"
  )
    return false;
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
  return (
    "explicitlyRejectsImageInput" in error &&
    error.explicitlyRejectsImageInput === true
  );
}
