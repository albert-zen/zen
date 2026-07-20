#!/usr/bin/env node
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { createServer as createViteServer } from 'vite';

import { resolveAgentAppDataRoot } from './app-data-root.js';
import {
  assertLoopbackBindAllowed,
  DEFAULT_APP_SERVER_HOST,
  readAppServerPort,
  readRemoteBindOptIn,
} from './app-server-config.js';
import { createAgentAppProductionComposition } from './agent-app-production.js';
import { createAgentAppHttpProxy, serveAgentAppHttpTransport } from './agent-app-transport.js';
import { runWebDevCliComposition } from './production-composition.js';

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
      agentAppServer: appServer as import('../../product/index.js').AgentAppClient,
      host: DEFAULT_APP_SERVER_HOST,
      port: 0,
    }),
  createVite: async (transport) => {
    const proxy = createAgentAppHttpProxy(transport.url, transport.capability);
    return await createViteServer({
      configFile: false,
      root: process.cwd(),
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
