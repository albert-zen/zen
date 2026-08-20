const zenxLogoPlaceholder = new URL(
  "./assets/zenx-logo-placeholder.svg",
  import.meta.url,
).href;

export function ZenXBrand() {
  return (
    <div className="brand" aria-label="ZenX">
      <img
        className="brand-mark"
        src={zenxLogoPlaceholder}
        alt=""
        aria-hidden="true"
      />
      <span className="brand-wordmark">ZENX</span>
    </div>
  );
}
