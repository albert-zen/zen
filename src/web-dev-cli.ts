#!/usr/bin/env node
import { createServer as createViteServer, type ProxyOptions } from "vite";

import {
  DEFAULT_APP_SERVER_HOST,
  readAppServerPort
} from "./app-server-config.js";
import { serveAppServerHttpTransport } from "./app-server-transport.js";
import { createProviderBackedAppServer } from "./provider-runtime.js";

const host = process.env.ZEN_WEB_HOST ?? DEFAULT_APP_SERVER_HOST;
const port = readAppServerPort(process.env.ZEN_WEB_PORT ?? "4174");
const appServer = await createProviderBackedAppServer({ cwd: process.cwd() });
const transport = await serveAppServerHttpTransport({
  appServer,
  host: DEFAULT_APP_SERVER_HOST,
  port: 0
});
const proxy = createAppServerProxy(transport.url);
const vite = await createViteServer({
  configFile: "web/vite.config.ts",
  server: {
    host,
    port,
    strictPort: false,
    proxy
  }
});

await vite.listen();
vite.printUrls();
console.log(`Zen App Server transport proxied from ${transport.url}`);

await new Promise<void>((resolve) => {
  const shutdown = () => resolve();

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
});

await vite.close();
await transport.close();

function createAppServerProxy(target: string): Record<string, ProxyOptions> {
  return {
    "/request": {
      target,
      changeOrigin: true
    },
    "/events": {
      target,
      changeOrigin: true
    }
  };
}
