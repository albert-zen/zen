#!/usr/bin/env node
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { createServer as createViteServer } from 'vite';

import {
  assertLoopbackBindAllowed,
  createAgentAppHttpProxy,
  createAgentAppProductionComposition,
  DEFAULT_APP_SERVER_HOST,
  readAppServerPort,
  readRemoteBindOptIn,
  resolveAgentAppDataRoot,
  runWebDevCliComposition,
  serveAgentAppHttpTransport,
} from '@zen/framework/node';
import type { AgentAppClient } from '@zen/framework/product';

const webRoot = resolve(import.meta.dirname, '..', '..', 'web');

const host = process.env.ZEN_WEB_HOST ?? DEFAULT_APP_SERVER_HOST;
const port = readAppServerPort(process.env.ZEN_WEB_PORT ?? '4174');
const allowRemoteBind = readRemoteBindOptIn(
  process.env.ZEN_WEB_ALLOW_REMOTE,
  'ZEN_WEB_ALLOW_REMOTE'
);
assertLoopbackBindAllowed(host, allowRemoteBind, 'Non-loopback Zen Web');

await runWebDevCliComposition({
  signalSource: process,
  createAppServer: async () => {
    const composition = await createAgentAppProductionComposition({
      appDataRoot: resolveAgentAppDataRoot(),
    });
    return {
      request: composition.agentAppServer.request.bind(composition.agentAppServer),
      subscribe: composition.agentAppServer.subscribe.bind(composition.agentAppServer),
      close: composition.close,
    };
  },
  createTransport: async (appServer) =>
    await serveAgentAppHttpTransport({
      agentAppServer: appServer as AgentAppClient,
      host: DEFAULT_APP_SERVER_HOST,
      port: 0,
    }),
  createVite: async (transport) => {
    const proxy = createAgentAppHttpProxy(transport.url, transport.capability);
    return await createViteServer({
      configFile: false,
      root: webRoot,
      plugins: [react(), tailwindcss()],
      server: {
        cors: false,
        host,
        port,
        strictPort: false,
        proxy,
      },
    });
  },
  onListening: (transport, vite) => {
    vite.printUrls?.();
    console.log(`Zen App Server transport proxied from ${transport.url}`);
  },
});
