import { Icon } from "./icons.js";

export type ProviderLogoKind =
  "openai" | "deepseek" | "qwen" | "local" | "generic";

export function ProviderLogo({ kind }: { kind: ProviderLogoKind }) {
  return (
    <span className={`provider-logo ${kind}`} aria-hidden="true">
      {kind === "openai" ? (
        <svg viewBox="0 0 18 18">
          <path
            d="M9 2.7a3 3 0 0 1 2.8 1.8 3 3 0 0 1 3.2 4.8 3 3 0 0 1-2.7 4.8A3 3 0 0 1 7 15.3a3 3 0 0 1-3.2-4.8 3 3 0 0 1 2.7-4.8A3 3 0 0 1 9 2.7Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <path
            d="m6.4 5.8 5.2 3v5.3M11.6 12.2l-5.2-3V4.8m.1 6.1L9 9.5l2.5-1.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.15"
          />
        </svg>
      ) : kind === "deepseek" ? (
        <svg viewBox="0 0 18 18">
          <path
            d="M3 10.5c1.8 2.9 5.2 4.4 8.2 3.4 2.4-.8 3.6-2.7 3.8-5.2-1.8 1-3.9.8-5.5-.6C7.4 6.2 5.6 7 3 10.5Z"
            fill="currentColor"
          />
          <circle cx="11.8" cy="9.7" r=".8" fill="var(--surface-2)" />
        </svg>
      ) : kind === "qwen" ? (
        <svg viewBox="0 0 18 18">
          <path
            d="M9 2.8a6.2 6.2 0 1 0 4.2 10.8l2 1.7v-4.6h-4.5l1.8 1.6A4.5 4.5 0 1 1 13.5 9h1.7A6.2 6.2 0 0 0 9 2.8Z"
            fill="currentColor"
          />
          <circle cx="9" cy="9" r="1.3" fill="var(--surface-2)" />
        </svg>
      ) : kind === "local" ? (
        <Icon name="terminal" size={13} />
      ) : (
        <svg viewBox="0 0 18 18">
          <path
            d="M9 3.1 14.9 9 9 14.9 3.1 9 9 3.1Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <circle cx="9" cy="9" r="1.4" fill="currentColor" />
        </svg>
      )}
    </span>
  );
}
