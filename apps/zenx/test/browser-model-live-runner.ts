/** JSONL trial through the real model facade, Host bundle, and Electron Browser backend.
 * Build with esbuild for Electron. Only the local synthetic fixture may be opened. */
import { app } from "electron";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { browserBridge } from "./model-browser-fixture.js";
import { BrowserBackendRegistry } from "../src/main/capabilities/browser-backend-registry.js";
import { ElectronBrowserBackend } from "../src/main/capabilities/browser-provider.js";
import { browserModelDefinition } from "../src/main/capabilities/model-browser-facade.js";

const directory = mkdtempSync(
  path.join(os.tmpdir(), "zenx-browser-model-trial-"),
);
app.setPath("userData", path.join(directory, "user-data"));
app.on("window-all-closed", () => undefined);
const html = `<!doctype html><title>Browser model trial</title><main><h1>Local fixture</h1>
<label>Draft <input aria-label="Draft"></label>
<button onclick="document.querySelector('output').textContent='Saved '+document.querySelector('input').value">Save draft</button>
<output>Not saved</output></main>`;
const print = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + "\n");
const trialToken = randomUUID();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const pending: string[] = [];
let inputClosed = false;
let wake: (() => void) | undefined;
lines.on("line", (line) => {
  pending.push(line);
  wake?.();
});
lines.on("close", () => {
  inputClosed = true;
  wake?.();
});
let bridge: Awaited<ReturnType<typeof browserBridge>> | undefined;
let fixtureUrl = "";
let stop!: () => void;
const stopped = new Promise<void>((resolve) => {
  stop = resolve;
});
async function execute(request: {
  tool?: unknown;
  args?: unknown;
}): Promise<unknown> {
  if (request.tool === "exit") {
    stop();
    return { exiting: true };
  }
  if (
    !bridge ||
    typeof request.tool !== "string" ||
    !request.tool.startsWith("browser_workspace_")
  )
    throw Error("Only ready Workspace Browser tools are accepted");
  const args =
    request.args &&
    typeof request.args === "object" &&
    !Array.isArray(request.args)
      ? { ...(request.args as Record<string, unknown>) }
      : {};
  if (
    request.tool === "browser_workspace_open" ||
    request.tool === "browser_workspace_navigate"
  ) {
    if (
      args.url !== undefined &&
      args.url !== "fixture" &&
      args.url !== fixtureUrl
    )
      throw Error(
        `Only the synthetic local fixture may be opened: use url ${JSON.stringify(fixtureUrl)} (or alias "fixture")`,
      );
    args.url = fixtureUrl;
  }
  return { tool: request.tool, result: await bridge.call(request.tool, args) };
}
const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url?.startsWith("/tools")) {
    const name = new URL(request.url, "http://127.0.0.1").searchParams.get(
      "name",
    );
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(
      JSON.stringify(
        name
          ? (definitions.find((tool) => tool.name === name) ?? {
              error: "Unknown tool; read /tools",
            })
          : {
              fixtureUrl,
              tools: definitions.map(({ name, description }) => ({
                name,
                description,
              })),
            },
      ),
    );
    return;
  }
  if (request.method === "POST" && request.url === "/invoke") {
    try {
      if (request.headers["x-zenx-trial-token"] !== trialToken) {
        response.statusCode = 403;
        throw Error("Trial token required");
      }
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
        if (body.length > 16_384) throw Error("Request exceeds JSON limit");
      }
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify(await execute(JSON.parse(body))) + "\n");
    } catch (error) {
      if (response.statusCode !== 403) response.statusCode = 400;
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }) + "\n",
      );
    }
    return;
  }
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(html);
});
let definitions: ReturnType<typeof browserModelDefinition>[] = [];
async function consumeStdin(): Promise<void> {
  while (pending.length > 0 || !inputClosed) {
    if (pending.length === 0)
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    wake = undefined;
    const line = pending.shift();
    if (!line?.trim()) continue;
    try {
      print(await execute(JSON.parse(line)));
    } catch (error) {
      print({ error: error instanceof Error ? error.message : String(error) });
    }
  }
}
async function main(): Promise<void> {
  try {
    print({ starting: true });
    await app.whenReady();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("Fixture listener unavailable");
    fixtureUrl = `http://127.0.0.1:${address.port}/`;
    const service = new BrowserBackendRegistry(
      new ElectronBrowserBackend({
        artifactDirectory: path.join(directory, "artifacts"),
      }),
    );
    bridge = await browserBridge(service);
    definitions = service.manifest.tools
      .filter((tool) => tool.name.startsWith("browser_workspace_"))
      .map(browserModelDefinition);
    print({
      ready: true,
      fixtureUrl,
      endpoint: fixtureUrl + "invoke",
      trialToken,
      catalog: fixtureUrl + "tools",
      toolSchema: fixtureUrl + "tools?name=TOOL_NAME",
    });
    void consumeStdin();
    await stopped;
  } catch (error) {
    print({ fatal: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  } finally {
    await bridge?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    print({
      temporaryData: directory,
      cleanup:
        "Remove after Electron exits if desired; path is a newly created trial directory.",
    });
    app.quit();
  }
}
void main();
