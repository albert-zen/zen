import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryAttachmentStore } from "../src/attachment.js";
import type { ModelAdapter, ModelRequest } from "../src/model.js";
import { OpenAiCompatibleModel } from "../src/model/openai-compatible.js";
import { OpenAiResponsesModel } from "../src/model/openai-responses.js";
import { OpenAiSubscriptionModel } from "../src/model/openai-subscription.js";
import { png1x1 } from "./fixtures.js";

const token = `synthetic.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-image-detail" } })).toString("base64url")}.synthetic`;
for (const protocol of ["chat", "subscription", "responses"] as const) {
  for (const role of ["user", "tool"] as const) {
    for (const requested of ["default", "high", "original"] as const) {
      test(`${protocol} serializes ${role} image ${requested} detail without overriding it`, async () => {
        const attachments = new InMemoryAttachmentStore();
        const attachment = await attachments.importBytes(png1x1());
        let body: unknown;
        const fetch: typeof globalThis.fetch = async (_url, init) => {
          body = JSON.parse(String(init?.body));
          return new Response(
            protocol === "chat"
              ? 'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
              : 'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
          );
        };
        const common = {
          baseUrl: "https://synthetic.invalid/v1",
          apiKey: "synthetic-not-real",
          attachments,
          fetch,
        };
        const adapter: ModelAdapter =
          protocol === "chat"
            ? new OpenAiCompatibleModel(common)
            : protocol === "responses"
              ? new OpenAiResponsesModel(common)
              : new OpenAiSubscriptionModel({
                  attachments,
                  fetch,
                  acquireAccessLease: async () => ({ accessToken: token }),
                });
        const image = {
          type: "image" as const,
          attachment,
          ...(requested === "default" ? {} : { detail: requested }),
        };
        const messages: ModelRequest["messages"] =
          role === "user"
            ? [{ role: "user", content: [image] }]
            : [
                {
                  role: "assistant",
                  toolCalls: [
                    { callId: "view", name: "view_image", arguments: {} },
                  ],
                },
                {
                  role: "tool",
                  callId: "view",
                  exitCode: 0,
                  text: "Synthetic image",
                  modelContent: [image],
                },
              ];
        for await (const _event of adapter.stream({
          model: "synthetic-image-model",
          reasoningEffort: "medium",
          messages,
          tools: [],
          signal: new AbortController().signal,
        })) {
          /* drain serialized request */
        }
        const images: Record<string, unknown>[] = [];
        const visit = (value: unknown): void => {
          if (value === null || typeof value !== "object") return;
          const object = value as Record<string, unknown>;
          if (object.type === "image_url")
            images.push(object.image_url as Record<string, unknown>);
          else if (object.type === "input_image") images.push(object);
          for (const child of Object.values(object)) visit(child);
        };
        visit(body);
        assert.equal(images.length, 1);
        const detail = requested === "default" ? undefined : requested;
        assert.equal(
          images[0]!.detail,
          protocol === "responses" ? (detail ?? "auto") : detail,
        );
      });
    }
  }
}
