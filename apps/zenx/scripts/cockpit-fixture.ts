import { build, preview } from "vite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { createCockpitHost } from "../test/fixtures/cockpit-host.js";
import type {
  ClientRequestMethod,
  ClientRequestParams,
} from "../src/protocol-client/types.js";

const host = await createCockpitHost();
const root = fileURLToPath(new URL("../../../", import.meta.url));
const outDir = await mkdtemp(path.join(tmpdir(), "zenx-cockpit-preview-"));
await build({
  configFile: false,
  root,
  publicDir: "apps/zenx/src/renderer/public",
  plugins: [react()],
  build: {
    outDir,
    emptyOutDir: false,
    rollupOptions: {
      input: path.join(root, "apps/zenx/test/fixtures/cockpit.html"),
    },
  },
});
const server = await preview({
  configFile: false,
  root,
  build: { outDir },
  plugins: [
    {
      name: "cockpit-fixture-api",
      configurePreviewServer(server) {
        server.middlewares.use("/cockpit-api", api);
        server.middlewares.use((request, _response, next) => {
          if (request.url === "/apps/zenx/test/fixtures/plugin-frame.html")
            request.url = "/plugin-frame.html";
          next();
        });
      },
    },
  ],
  preview: { host: "127.0.0.1", port: 5193, strictPort: true },
});
async function api(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
) {
  response.setHeader("Content-Type", "application/json");
  try {
    if (request.method === "GET") {
      response.end(JSON.stringify(await host.appServer.listThreadSummaries()));
      return;
    }
    let body = "";
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 100_000) throw new Error("Request too large");
    }
    const { method, params } = JSON.parse(body) as {
      method: ClientRequestMethod;
      params: ClientRequestParams[ClientRequestMethod];
    };
    if (
      ![
        "zen/thread/read",
        "turn/start",
        "turn/steer",
        "turn/interrupt",
      ].includes(method)
    )
      throw new Error("Unsupported fixture request");
    response.end(JSON.stringify(await host.client.request(method, params)));
  } catch (error) {
    response.statusCode = 400;
    response.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
console.log(
  "Cockpit fixture: http://127.0.0.1:5193/apps/zenx/test/fixtures/cockpit.html",
);
console.log(
  "Real Runtime + process plugin + canonical Items. Deterministic author, not an online model. In-memory data only.",
);
const close = async () => {
  await new Promise<void>((resolve, reject) =>
    server.httpServer.close((error) => (error ? reject(error) : resolve())),
  );
  await host.close();
  process.exit(0);
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
