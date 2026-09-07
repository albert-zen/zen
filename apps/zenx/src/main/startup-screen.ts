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
  const title = error === undefined ? "Starting ZenX…" : "ZenX could not start";
  const detail =
    error === undefined ? "Preparing your local runtime and plugins." : error;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>ZenX</title><style>
body{margin:0;background:#0b0d10;color:#e4e7ec;font:15px system-ui,sans-serif;display:grid;place-items:center;height:100vh}.surface{max-width:640px;padding:40px}h1{font-size:24px;font-weight:600}p{color:#aab1bd;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}.brand{letter-spacing:.3em;color:#72dcb5}.bar{height:3px;background:#72dcb5;margin-top:24px;width:72px}header{position:fixed;inset:0 0 auto;height:44px;-webkit-app-region:drag}
</style></head><body><header></header><main class="surface" role="${error === undefined ? "status" : "alert"}"><div class="brand">ZENX</div><h1>${title}</h1><p>${escape(detail)}</p>${error === undefined ? '<div class="bar" aria-hidden="true"></div>' : "<p>Close this window and reopen ZenX to try again.</p>"}</main></body></html>`;
}
