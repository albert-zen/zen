#!/usr/bin/env node
import { createOpenClawAppServer } from "./openclaw-runtime.js";
import { serveAppServerHttpTransport } from "./app-server-transport.js";
import {
  DEFAULT_APP_SERVER_HOST,
  readAppServerPort
} from "./app-server-config.js";

const host = process.env.ZEN_APP_SERVER_HOST ?? DEFAULT_APP_SERVER_HOST;
const port = readAppServerPort(process.env.ZEN_APP_SERVER_PORT);
const server = await createOpenClawAppServer({ cwd: process.cwd() });
const transport = await serveAppServerHttpTransport({
  appServer: server,
  host,
  port
});

console.log(`Zen App Server listening at ${transport.url}`);

await new Promise<void>((resolve) => {
  const shutdown = () => resolve();

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
});

await transport.close();
