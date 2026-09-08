import { startupBrand } from "./startup-brand.js";

/** Static startup UI loads without invoking any not-yet-installed renderer IPC. */
export function startupScreenHtml(error?: string): string {
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/gu,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char]!,
    );
  const title =
    error === undefined ? "Preparing your superpower" : "ZenX could not start";
  const detail =
    error === undefined ? "A little setup. A lot of possibility." : error;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>ZenX</title><style>
*{box-sizing:border-box}body{margin:0;background:#101215;color:#f0f2f4;font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;place-items:center;min-height:100vh;color-scheme:dark}.surface{width:min(620px,100%);padding:64px 32px;text-align:center}.brand{width:min(288px,80%);margin:0 auto 52px;color:inherit}.brand svg{display:block;width:100%;height:auto}h1{margin:0;font-size:clamp(22px,3.4vw,30px);font-weight:500;letter-spacing:-.035em;line-height:1.3}p{margin:14px 0 0;color:#a5adb8;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}.bar{height:3px;background:#2a3334;margin:36px auto 0;width:112px;overflow:hidden;border-radius:4px}.bar:after{content:"";display:block;width:48px;height:100%;background:#70cfaf;border-radius:4px;animation:prepare 1.8s ease-in-out infinite}@keyframes prepare{0%{transform:translateX(-48px)}100%{transform:translateX(112px)}}header{position:fixed;inset:0 0 auto;height:44px;-webkit-app-region:drag}@media(prefers-color-scheme:light){body{background:#f7f8fa;color:#20252c;color-scheme:light}p{color:#626c7b}.bar{background:#dce7e1}.bar:after{background:#24785f}}@media(prefers-reduced-motion:reduce){.bar:after{animation:none;margin:auto}}
</style></head><body><header></header><main class="surface" role="${error === undefined ? "status" : "alert"}"><div class="brand">${startupBrand}</div><h1>${title}</h1><p>${escape(detail)}</p>${error === undefined ? '<div class="bar" aria-hidden="true"></div>' : "<p>Close this window and reopen ZenX to try again.</p>"}</main></body></html>`;
}
