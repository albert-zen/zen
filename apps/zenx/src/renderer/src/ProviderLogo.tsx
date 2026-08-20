import { Icon } from "./icons.js";

export type ProviderLogoKind =
  "openai" | "deepseek" | "qwen" | "local" | "generic";

const formalProviderAssets: Partial<Record<ProviderLogoKind, string>> = {
  openai: new URL("./assets/providers/openai.svg", import.meta.url).href,
  deepseek: new URL("./assets/providers/deepseek.svg", import.meta.url).href,
  qwen: new URL("./assets/providers/qwen.svg", import.meta.url).href,
};

export function ProviderLogo({ kind }: { kind: ProviderLogoKind }) {
  const asset = formalProviderAssets[kind];
  return (
    <span className={`provider-logo ${kind}`} aria-hidden="true">
      {asset !== undefined ? (
        <img alt="" src={asset} />
      ) : kind === "local" ? (
        <Icon name="terminal" size={13} />
      ) : kind === "generic" ? (
        <svg viewBox="0 0 18 18">
          <path
            d="M9 3.1 14.9 9 9 14.9 3.1 9 9 3.1Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <circle cx="9" cy="9" r="1.4" fill="currentColor" />
        </svg>
      ) : null}
    </span>
  );
}
