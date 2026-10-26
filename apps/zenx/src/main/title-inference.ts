import type { ZenXSettingsService } from "./settings-service.js";
import type { ThreadTitleInference } from "./thread-title-types.js";
import type { AppServerManager } from "./app-server-manager.js";
import { canonicalTitleSource } from "../../../../src/model-operations.js";
import { textFromUserInput } from "../../../../src/item.js";

type TitleHost = Pick<
  AppServerManager,
  "request" | "onNotification" | "runModelOperation"
>;
export class ZenXConfiguredTitleInference implements ThreadTitleInference {
  constructor(
    readonly settings: ZenXSettingsService,
    readonly host?: TitleHost,
  ) {}
  async generate(
    input: string,
    model: string,
    signal: AbortSignal,
    context?: { threadId: string },
  ): Promise<string> {
    const configured = await this.settings.titleOperationConfiguration();
    try {
      if (configured.selection.modelId !== model)
        throw new Error("Configured title model changed; retry explicitly");
      if (configured.provider.provider.type === "fake") {
        await new Promise<void>((resolve, reject) => {
          signal.throwIfAborted();
          const abort = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
          }, 1500);
          signal.addEventListener("abort", abort, { once: true });
        });
        return localSemanticTitle(input);
      }
      if (!this.host || !context)
        throw new Error("Canonical title Host context is unavailable");
      const sourceItemId = await awaitCanonicalTitleSource(
        this.host,
        context.threadId,
        signal,
      );
      const result = await this.host.runModelOperation(
        {
          input: {
            kind: "title",
            threadId: context.threadId,
            sourceItemId,
            selection: configured.selection,
            ...(configured.titlePrompt === undefined
              ? {}
              : { titleTemplate: configured.titlePrompt }),
          },
          profile: configured.provider,
        },
        signal,
      );
      signal.throwIfAborted();
      if (result.status !== "completed")
        throw new Error(result.error ?? "Title model operation failed");
      return textFromUserInput(result.content ?? []);
    } finally {
      await configured.release();
    }
  }
}

/** Wait only for the existing canonical admission; never infer identity from draft text. */
export async function awaitCanonicalTitleSource(
  host: TitleHost,
  threadId: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  return await new Promise<string>((resolve, reject) => {
    let done = false;
    const finish = (id?: string, error?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      dispose();
      signal.removeEventListener("abort", abort);
      if (id) resolve(id);
      else reject(error);
    };
    const abort = () => finish(undefined, signal.reason);
    const timer = setTimeout(
      () =>
        finish(
          undefined,
          new Error(
            "No canonical user input is available for title generation",
          ),
        ),
      30000,
    );
    const read = () =>
      void host.request("thread/read", { threadId, includeTurns: true }).then(
        ({ thread }) => {
          for (const turn of thread.turns)
            for (const item of turn.items)
              if (
                item.type === "userMessage" &&
                canonicalTitleSource(
                  item.content.map((part) => part.text).join("\n"),
                )
              ) {
                finish(item.id);
                return;
              }
        },
        (error) => finish(undefined, error),
      );
    const dispose = host.onNotification((method, params) => {
      if (method !== "item/completed") return;
      const event =
        params as import("../protocol-client/index.js").ServerNotificationParams["item/completed"];
      if (event.threadId === threadId && event.item.type === "userMessage")
        read();
    });
    signal.addEventListener("abort", abort, { once: true });
    read();
  });
}
function localSemanticTitle(input: string): string {
  return input.trim().split(/\s+/u).slice(0, 8).join(" ") || "New conversation";
}
