import { streamAuxiliaryModel } from "../../../../src/auxiliary-model.js";
import type { ZenXSettingsService } from "./settings-service.js";
import type { ThreadTitleInference } from "./thread-title-types.js";
import { renderTitlePrompt } from "./workflow-configuration.js";

export class ZenXConfiguredTitleInference implements ThreadTitleInference {
  readonly #settings: ZenXSettingsService;

  constructor(settings: ZenXSettingsService) {
    this.#settings = settings;
  }

  async generate(
    input: string,
    model: string,
    signal: AbortSignal,
  ): Promise<string> {
    const configured = await this.#settings.titleModel(signal);
    try {
      if (configured.model !== model)
        throw new Error("Configured title model changed; retry explicitly");
      if (configured.adapter === null) {
        signal.throwIfAborted();
        configured.assertDispatchAllowed();
        // Keep the local demo faithful to the asynchronous product lifecycle.
        await new Promise<void>((resolve, reject) => {
          const aborted = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", aborted);
            resolve();
          }, 1_500);
          signal.addEventListener("abort", aborted, { once: true });
        });
        return localSemanticTitle(input);
      }
      let text = "";
      for await (const event of streamAuxiliaryModel({
        adapter: configured.adapter,
        trace: configured.trace,
        itemListStore: configured.itemListStore,
        purpose: "title",
        configuration: configured.configuration,
        assertDispatchAllowed: configured.assertDispatchAllowed,
        model,
        reasoningEffort: configured.reasoningEffort,
        messages: [
          {
            role: "user",
            text: renderTitlePrompt(configured.titlePrompt, input),
          },
        ],
        tools: [],
        signal,
      })) {
        if (event.type === "text_delta") text += event.delta;
      }
      return text;
    } finally {
      await configured.release();
    }
  }
}

function localSemanticTitle(input: string): string {
  const words = input.trim().split(/\s+/u).slice(0, 8).join(" ");
  return words.length > 0 ? words : "New conversation";
}
