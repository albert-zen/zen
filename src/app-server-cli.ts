#!/usr/bin/env node
import { createOpenClawAppServer } from "./openclaw-runtime.js";
import { serveAppServerHttpTransport } from "./app-server-transport.js";

const host = process.env.ZEN_APP_SERVER_HOST ?? "127.0.0.1";
const port = readPort(process.env.ZEN_APP_SERVER_PORT);
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

function readPort(value: string | undefined): number {
  if (!value) {
    return 0;
  }

  const port = Number(value);

  if (Number.isInteger(port) && port >= 0 && port <= 65_535) {
    return port;
  }

  throw new Error("ZEN_APP_SERVER_PORT must be an integer from 0 to 65535");
}
