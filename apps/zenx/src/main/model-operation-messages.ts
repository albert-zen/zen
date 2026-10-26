import type {
  RunModelOperationInput,
  ModelOperationResult,
} from "../../../../src/app-server.js";
import type { HostProviderProfile } from "../../../../apps/cli/src/host.js";
import type { CanonicalItem } from "../../../../src/item.js";
import type { NativeThreadSummary } from "../../../../src/thread-summary.js";

/** Private parent/Host IPC only; never a native, Fleet, tool or renderer execution API. */
export interface HostModelOperationRequest {
  input: RunModelOperationInput;
  profile?: HostProviderProfile;
}
export type HostModelOperationHistory =
  | { summaries: NativeThreadSummary[] }
  | { threadId: string; items: readonly CanonicalItem[] };
export type HostModelOperationResult = ModelOperationResult;
export function validateHostModelOperationRequest(
  value: unknown,
): asserts value is HostModelOperationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid model operation request");
  for (const key of Object.keys(value))
    if (!["input", "profile"].includes(key))
      throw new Error("Unknown model operation envelope field");
  const request = value as HostModelOperationRequest;
  const input = request.input;
  if (
    !input ||
    !["title", "image-capability-probe"].includes(input.kind) ||
    !input.selection ||
    typeof input.selection.providerProfileId !== "string" ||
    !input.selection.providerProfileId ||
    typeof input.selection.modelId !== "string" ||
    !input.selection.modelId ||
    (input.selection.reasoningEffort !== undefined &&
      input.selection.reasoningEffort !== null &&
      typeof input.selection.reasoningEffort !== "string")
  )
    throw new Error("Invalid model operation selection");
  if (
    input.kind === "title" &&
    (typeof input.threadId !== "string" ||
      !input.threadId ||
      typeof input.sourceItemId !== "string" ||
      !input.sourceItemId ||
      (input.titleTemplate !== undefined &&
        (typeof input.titleTemplate !== "string" ||
          input.titleTemplate.length > 32768 ||
          !input.titleTemplate.includes("{{request}}"))))
  )
    throw new Error("Invalid canonical title source");
  const inputKeys =
    input.kind === "title"
      ? ["kind", "threadId", "sourceItemId", "selection", "titleTemplate"]
      : ["kind", "selection"];
  for (const key of Object.keys(input))
    if (!inputKeys.includes(key))
      throw new Error("Unknown model operation input field");
  for (const key of Object.keys(input.selection))
    if (
      !(
        input.kind === "title"
          ? ["providerProfileId", "modelId", "reasoningEffort"]
          : ["providerProfileId", "modelId"]
      ).includes(key)
    )
      throw new Error("Unknown or overridden model operation selection field");
  if (request.profile !== undefined) {
    const profile = request.profile;
    for (const key of Object.keys(profile))
      if (
        ![
          "providerProfileId",
          "provider",
          "model",
          "modelCatalog",
          "models",
          "transport",
        ].includes(key)
      )
        throw new Error("Unknown draft provider field");
    if (
      !profile ||
      typeof profile !== "object" ||
      profile.providerProfileId !== input.selection.providerProfileId ||
      typeof profile.model !== "string" ||
      !profile.provider ||
      !["fake", "openai-compatible", "openai-subscription"].includes(
        profile.provider.type,
      )
    )
      throw new Error("Invalid draft provider profile");
    if (
      profile.provider.type === "openai-compatible" &&
      (typeof profile.provider.baseUrl !== "string" ||
        typeof profile.provider.apiKey !== "string")
    )
      throw new Error("Invalid draft Provider credentials");
    if (
      profile.provider.type === "openai-subscription" &&
      typeof profile.provider.profilePath !== "string"
    )
      throw new Error("Invalid subscription profile");
    if (
      profile.provider.type === "openai-compatible" &&
      profile.provider.defaultParams &&
      Object.keys(profile.provider.defaultParams).some((key) =>
        [
          "messages",
          "input",
          "instructions",
          "tools",
          "system",
          "user",
        ].includes(key),
      )
    )
      throw new Error(
        "Draft protocol parameters cannot construct model content",
      );
    if (
      "adapter" in profile ||
      "journal" in profile ||
      "attachments" in profile
    )
      throw new Error(
        "Execution objects cannot cross the model operation IPC boundary",
      );
  }
  if (JSON.stringify(value).length > 1024 * 1024)
    throw new Error("Model operation configuration is too large");
}
