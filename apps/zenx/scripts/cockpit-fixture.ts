import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { createCockpitHost } from "../test/fixtures/cockpit-host.js";
import type {
  ClientRequestMethod,
  ClientRequestParams,
} from "../src/protocol-client/types.js";

const host = await createCockpitHost();
const root = fileURLToPath(new URL("../../../", import.meta.url));
const server = await createServer({
  configFile: false,
  root,
  publicDir: "apps/zenx/src/renderer/public",
  plugins: [
    react(),
    {
      name: "cockpit-fixture-api",
      configureServer(server) {
        server.middlewares.use("/cockpit-api", api);
      },
    },
  ],
  server: { host: "127.0.0.1", port: 5193, strictPort: true },
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
await server.listen();
console.log(
  "Cockpit fixture: http://127.0.0.1:5193/apps/zenx/test/fixtures/cockpit.html",
);
console.log(
  "Real Runtime + process plugin + canonical Items. Deterministic author, not an online model. In-memory data only.",
);
const close = async () => {
  await server.close();
  await host.close();
  process.exit(0);
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
