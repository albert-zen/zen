export interface ZenXKnownProviderPreset {
  readonly providerProfileId: string;
  readonly name: string;
  readonly displayName: string;
  readonly baseUrl: string;
}

export const KNOWN_PROVIDER_PRESETS: readonly ZenXKnownProviderPreset[] =
  Object.freeze([
    knownProviderPreset(
      "siliconflow",
      "SiliconFlow（硅基流动）",
      "https://api.siliconflow.cn/v1",
    ),
    knownProviderPreset(
      "dashscope",
      "DashScope",
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    ),
    knownProviderPreset("deepseek", "DeepSeek", "https://api.deepseek.com"),
    knownProviderPreset("kimi", "Kimi", "https://api.moonshot.cn/v1"),
    knownProviderPreset(
      "zhipu",
      "Zhipu（智谱）",
      "https://open.bigmodel.cn/api/paas/v4",
    ),
  ]);

function knownProviderPreset(
  identity: string,
  displayName: string,
  baseUrl: string,
): ZenXKnownProviderPreset {
  return Object.freeze({
    providerProfileId: identity,
    name: identity,
    displayName,
    baseUrl,
  });
}
