import type { ModelCatalogEntryInput } from "../../../../src/model-catalog.js";
import type { ProviderTransport } from "../../../../apps/cli/src/host.js";
import type {
  HostModelOperationRequest,
  HostModelOperationResult,
} from "./model-operation-messages.js";
export type ImageCapabilityProbeOutcome =
  "supported" | "unsupported" | "inconclusive";
export type ModelOperationExecutor = (
  request: HostModelOperationRequest,
  signal?: AbortSignal,
) => Promise<HostModelOperationResult>;

/** No adapter/semantic message construction here: the owning Host commits then dispatches. */
export async function probeOpenAiCompatibleImage(options: {
  baseUrl: string;
  protocol?: "chat-completions" | "responses";
  apiKey: string;
  provider: string;
  providerProfileId?: string;
  model: string;
  metadata?: ModelCatalogEntryInput;
  transport?: ProviderTransport;
  signal?: AbortSignal;
  execute: ModelOperationExecutor;
}): Promise<ImageCapabilityProbeOutcome> {
  const providerProfileId = options.providerProfileId ?? "explicit-image-probe";
  const result = await options.execute(
    {
      input: {
        kind: "image-capability-probe",
        selection: { providerProfileId, modelId: options.model },
      },
      profile: {
        providerProfileId,
        model: options.model,
        provider: {
          type: "openai-compatible",
          baseUrl: options.baseUrl,
          apiKey: options.apiKey,
          name: options.provider,
          ...(options.protocol === undefined
            ? {}
            : { protocol: options.protocol }),
        },
        modelCatalog: [
          {
            ...(options.metadata ?? {
              contextWindow: null,
              supportedReasoningEfforts: null,
              defaultReasoningEffort: null,
            }),
            id: options.model,
            isDefault: true,
          },
        ],
        ...(options.transport === undefined
          ? {}
          : { transport: options.transport }),
      },
    },
    options.signal,
  );
  return result.probeOutcome ?? "inconclusive";
}
