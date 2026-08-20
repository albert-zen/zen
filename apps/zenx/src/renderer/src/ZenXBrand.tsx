import type { CSSProperties } from "react";

const zenxMark = new URL("./assets/brand/zenx-mark.svg", import.meta.url).href;
const zenxWordmark = new URL(
  "./assets/brand/zenx-wordmark.svg",
  import.meta.url,
).href;

function brandAssetStyle(asset: string): CSSProperties {
  return { "--zenx-brand-asset": `url("${asset}")` } as CSSProperties;
}

export function ZenXBrand() {
  return (
    <div className="brand" aria-label="ZenX">
      <span
        className="brand-mark"
        style={brandAssetStyle(zenxMark)}
        aria-hidden="true"
      />
      <span
        className="brand-wordmark"
        style={brandAssetStyle(zenxWordmark)}
        aria-hidden="true"
      />
    </div>
  );
}
