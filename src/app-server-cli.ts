#!/usr/bin/env node
import { rm } from "node:fs/promises";

import { createProviderBackedAppServer } from "./provider-runtime.js";
import { serveAppServerHttpTransport } from "./app-server-transport.js";
import {
  DEFAULT_APP_SERVER_HOST,
  readAppServerPort,
  readRemoteBindOptIn,
  writeAppServerClientHandoff
} from "./app-server-config.js";

const host = process.env.ZEN_APP_SERVER_HOST ?? DEFAULT_APP_SERVER_HOST;
const port = readAppServerPort(process.env.ZEN_APP_SERVER_PORT);
const providedCapability = process.env.ZEN_APP_SERVER_CAPABILITY;
const handoffPath = process.env.ZEN_APP_SERVER_CAPABILITY_FILE;
const allowRemoteBind = readRemoteBindOptIn(
  process.env.ZEN_APP_SERVER_ALLOW_REMOTE,
  "ZEN_APP_SERVER_ALLOW_REMOTE"
);

if (!providedCapability && !handoffPath) {
  throw new Error(
    "Set ZEN_APP_SERVER_CAPABILITY or ZEN_APP_SERVER_CAPABILITY_FILE for capability handoff"
  );
}

const server = await createProviderBackedAppServer({ cwd: process.cwd() });
const transport = await serveAppServerHttpTransport({
  allowRemoteBind,
  appServer: server,
  capability: providedCapability,
  host,
  port
});

try {
  if (handoffPath) {
    await writeAppServerClientHandoff(handoffPath, {
      baseUrl: transport.url,
      capability: transport.capability
    });
  }

  console.log(`Zen App Server listening at ${transport.url}`);

  await new Promise<void>((resolve) => {
    const shutdown = () => resolve();

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
} finally {
  if (handoffPath) {
    await rm(handoffPath, { force: true });
  }

  await transport.close();
}
