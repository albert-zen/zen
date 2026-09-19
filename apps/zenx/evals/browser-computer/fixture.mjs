import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** Offline UI tasks: no accounts, external assets, or user data. */
export function evaluationPage(task) {
  const pages = {
    form: `<h1>Delivery form</h1><form><label for="recipient">Recipient</label><input id="recipient" name="recipient" autocomplete="off"><label for="city">City</label><input id="city" name="city" autocomplete="off"><button>Save delivery</button></form><output aria-live="polite">Not saved</output><script>document.querySelector('form').onsubmit=e=>{e.preventDefault();document.querySelector('output').textContent=document.querySelector('#recipient').value==='ZenX 测试'&&document.querySelector('#city').value==='杭州'?'PASS: delivery saved for ZenX 测试 in 杭州':'FAIL: incorrect delivery';};</script>`,
    scroll: `<h1>Long page</h1><p>Find the Finish task button at the bottom and activate it.</p><div style="height:2200px" aria-hidden="true"></div><button onclick="document.querySelector('output').textContent='PASS: bottom reached'">Finish task</button><output aria-live="polite">Not finished</output>`,
    stale: `<h1>Changing controls</h1><p>Refresh controls, then use the new Confirm current button.</p><button id="refresh" onclick="document.querySelector('#slot').innerHTML='<button id=confirm onclick=finish()>Confirm current</button>';this.disabled=true">Refresh controls</button><div id="slot"><button id="confirm" onclick="document.querySelector('output').textContent='FAIL: old control used'">Confirm old</button></div><output aria-live="polite">Not confirmed</output><script>function finish(){document.querySelector('output').textContent='PASS: current control confirmed'}</script>`,
    tabs: `<h1>Tab ownership</h1><p>Keep this source tab open. Open the Destination link in a separate tab, then return here.</p><a href="/destination" target="_blank" rel="noopener">Destination</a><button onclick="document.querySelector('output').textContent='PASS: source retained'">Confirm source retained</button><output aria-live="polite">Not confirmed</output>`,
    destination: `<h1>Destination</h1><p>Destination code: ORCHID-42</p>`,
    disabled: `<h1>Available actions</h1><button disabled>Submit disabled</button><button onclick="document.querySelector('output').textContent='PASS: enabled action selected'">Submit enabled</button><output aria-live="polite">Not submitted</output>`,
  };
  const body = pages[task];
  if (body === undefined) return undefined;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ZenX eval: ${task}</title><style>body{font:18px system-ui;margin:32px;max-width:760px}label,input,button,output{display:block;margin:12px 0}input,button{font:inherit;padding:8px}output{white-space:pre-wrap}</style><main>${body}</main></html>`;
}

export function createEvaluationServer() {
  return createServer((request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405).end("GET only");
      return;
    }
    const task =
      new URL(request.url, "http://localhost").pathname.slice(1) || "form";
    const html = evaluationPage(task);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response
      .writeHead(html === undefined ? 404 : 200)
      .end(html ?? "Unknown task");
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const server = createEvaluationServer();
  const port = Number(process.env.PORT ?? 0);
  server.listen(port, "127.0.0.1", () => {
    console.log(
      `ZenX evaluation fixture: http://127.0.0.1:${server.address().port}/form`,
    );
    console.log(
      "Tasks: /form /scroll /stale /tabs /disabled; Ctrl+C stops this local fixture.",
    );
  });
}
