#!/usr/bin/env node
import { createServer as createViteServer } from "vite";

import {
  assertLoopbackBindAllowed,
  DEFAULT_APP_SERVER_HOST,
  readAppServerPort,
  readRemoteBindOptIn
} from "./app-server-config.js";
import {
  createAppServerHttpProxy,
  serveAppServerHttpTransport
} from "./app-server-transport.js";
import { createProviderBackedAppServer } from "./provider-runtime.js";

const host = process.env.ZEN_WEB_HOST ?? DEFAULT_APP_SERVER_HOST;
const port = readAppServerPort(process.env.ZEN_WEB_PORT ?? "4174");
const allowRemoteBind = readRemoteBindOptIn(
  process.env.ZEN_WEB_ALLOW_REMOTE,
  "ZEN_WEB_ALLOW_REMOTE"
);
assertLoopbackBindAllowed(host, allowRemoteBind, "Non-loopback Zen Web");
const appServer = await createProviderBackedAppServer({ cwd: process.cwd() });
const transport = await serveAppServerHttpTransport({
  appServer,
  host: DEFAULT_APP_SERVER_HOST,
  port: 0
});
const proxy = createAppServerHttpProxy(transport.url, transport.capability);
const previousCapability = process.env.ZEN_APP_SERVER_CAPABILITY;
process.env.ZEN_APP_SERVER_CAPABILITY = transport.capability;
let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;

try {
  try {
    vite = await createViteServer({
      configFile: "web/vite.config.ts",
      server: {
        host,
        port,
        strictPort: false,
        proxy
      }
    });
  } finally {
    if (previousCapability === undefined) {
      delete process.env.ZEN_APP_SERVER_CAPABILITY;
    } else {
      process.env.ZEN_APP_SERVER_CAPABILITY = previousCapability;
    }
  }

  await vite.listen();
  vite.printUrls();
  console.log(`Zen App Server transport proxied from ${transport.url}`);

  await new Promise<void>((resolve) => {
    const shutdown = () => resolve();

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
} finally {
  await vite?.close();
  await transport.close();
}
