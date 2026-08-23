import assert from "node:assert/strict";
import test from "node:test";

import { KNOWN_PROVIDER_PRESETS } from "../src/main/provider-presets.js";

test("known OpenAI-compatible Provider presets have stable identities and official endpoints", () => {
  assert.deepEqual(KNOWN_PROVIDER_PRESETS, [
    {
      providerProfileId: "siliconflow",
      name: "siliconflow",
      displayName: "SiliconFlow（硅基流动）",
      baseUrl: "https://api.siliconflow.cn/v1",
    },
    {
      providerProfileId: "dashscope",
      name: "dashscope",
      displayName: "DashScope",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    },
    {
      providerProfileId: "deepseek",
      name: "deepseek",
      displayName: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
    },
    {
      providerProfileId: "kimi",
      name: "kimi",
      displayName: "Kimi",
      baseUrl: "https://api.moonshot.cn/v1",
    },
    {
      providerProfileId: "zhipu",
      name: "zhipu",
      displayName: "Zhipu（智谱）",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    },
  ]);
});
