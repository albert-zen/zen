import { Icon } from "./icons.js";

export type ProviderLogoKind =
  | "openai"
  | "siliconflow"
  | "dashscope"
  | "deepseek"
  | "moonshot"
  | "zhipu"
  | "qwen"
  | "local"
  | "generic";

const formalProviderAssets: Partial<Record<ProviderLogoKind, string>> = {
  openai: new URL("./assets/providers/openai.svg", import.meta.url).href,
  siliconflow: new URL(
    "./assets/providers/siliconflow.svg",
    import.meta.url,
  ).href,
  dashscope: new URL("./assets/providers/dashscope.png", import.meta.url).href,
  deepseek: new URL("./assets/providers/deepseek.svg", import.meta.url).href,
  moonshot: new URL("./assets/providers/moonshot.ico", import.meta.url).href,
  zhipu: new URL("./assets/providers/zhipu.svg", import.meta.url).href,
  qwen: new URL("./assets/providers/qwen.svg", import.meta.url).href,
};

export function providerLogoKindForIdentity(
  provider: string,
  modelOrDisplayName: string,
): ProviderLogoKind {
  const identity = `${provider} ${modelOrDisplayName}`.toLocaleLowerCase();
  if (identity.includes("siliconflow") || identity.includes("硅基流动"))
    return "siliconflow";
  if (identity.includes("dashscope") || identity.includes("百炼")) return "dashscope";
  if (identity.includes("deepseek")) return "deepseek";
  if (
    identity.includes("moonshot") ||
    identity.includes("kimi") ||
    identity.includes("月之暗面")
  )
    return "moonshot";
  if (
    identity.includes("zhipu") ||
    identity.includes("智谱") ||
    identity.includes("glm-")
  )
    return "zhipu";
  if (identity.includes("qwen")) return "qwen";
  if (identity.includes("openai") || /^gpt-/iu.test(modelOrDisplayName)) return "openai";
  if (identity.includes("local")) return "local";
  return "generic";
}

export function ProviderLogo({ kind }: { kind: ProviderLogoKind }) {
  const asset = formalProviderAssets[kind];
  return (
    <span className={`provider-logo ${kind}`} aria-hidden="true">
      {asset !== undefined ? (
        <img alt="" src={asset} />
      ) : kind === "local" ? (
        <Icon name="terminal" size={13} />
      ) : kind === "generic" ? (
        <Icon name="layers" size={13} />
      ) : null}
    </span>
  );
}
