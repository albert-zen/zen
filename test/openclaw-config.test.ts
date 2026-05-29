import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadOpenClawModelConfig } from "../src/index.js";

describe("OpenClaw config", () => {
  it("loads the primary OpenAI-compatible model without exposing unrelated config", () => {
    const dir = mkdtempSync(join(tmpdir(), "zen-openclaw-"));
    const path = join(dir, "openclaw.json");
    writeFileSync(
      path,
      JSON.stringify({
        agents: {
          defaults: {
            model: { primary: "DashScope/kimi-k2.6" }
          }
        },
        models: {
          providers: {
            DashScope: {
              baseUrl: "https://example.test/v1",
              apiKey: "test-key",
              models: [
                {
                  id: "kimi-k2.6",
                  name: "Kimi K2.6",
                  params: { max_completion_tokens: 1000 }
                }
              ]
            }
          }
        }
      }),
      "utf8"
    );

    expect(loadOpenClawModelConfig({ path })).toEqual({
      providerName: "DashScope",
      modelId: "kimi-k2.6",
      displayName: "Kimi K2.6",
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      params: { max_completion_tokens: 1000 }
    });
  });
});
