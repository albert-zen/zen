/** JSONL trial through the real model facade, Host bundle, and Electron Browser backend.
 * Build with esbuild for Electron. Only the local synthetic fixture may be opened. */
import { app } from "electron";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { browserBridge } from "./model-browser-fixture.js";
import { BrowserBackendRegistry } from "../src/main/capabilities/browser-backend-registry.js";
import { ElectronBrowserBackend } from "../src/main/capabilities/browser-provider.js";

const directory = mkdtempSync(path.join(os.tmpdir(), "zenx-browser-model-trial-"));
app.setPath("userData", path.join(directory, "user-data"));
app.on("window-all-closed", () => undefined);
const html = `<!doctype html><title>Browser model trial</title><main><h1>Local fixture</h1>
<label>Draft <input aria-label="Draft"></label>
<button onclick="document.querySelector('output').textContent='Saved '+document.querySelector('input').value">Save draft</button>
<output>Not saved</output></main>`;
const server = createServer((_request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(html);
});
const print = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
let bridge: Awaited<ReturnType<typeof browserBridge>> | undefined;
try {
  print({ starting: true });
  await app.whenReady();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Fixture listener unavailable");
  const fixtureUrl = `http://127.0.0.1:${address.port}/`;
  bridge = await browserBridge(new BrowserBackendRegistry(new ElectronBrowserBackend({ artifactDirectory: path.join(directory, "artifacts") })));
  print({ ready: true, fixture: "synthetic local page", tools: bridge.bundle.tools.filter((tool) => tool.name.startsWith("browser_workspace_")).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const request = JSON.parse(line) as { tool?: unknown; args?: unknown };
      if (request.tool === "exit") break;
      if (typeof request.tool !== "string" || !request.tool.startsWith("browser_workspace_")) throw Error("Only Workspace Browser tools are accepted");
      const args = request.args && typeof request.args === "object" && !Array.isArray(request.args) ? { ...request.args as Record<string, unknown> } : {};
      if (request.tool === "browser_workspace_open" || request.tool === "browser_workspace_navigate") {
        if (args.url !== undefined && args.url !== "fixture") throw Error("Only the synthetic local fixture may be opened");
        args.url = fixtureUrl;
      }
      print({ tool: request.tool, result: await bridge.call(request.tool, args) });
    } catch (error) {
      print({ error: error instanceof Error ? error.message : String(error) });
    }
  }
} catch (error) {
  print({ fatal: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  await bridge?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
  app.quit();
}
