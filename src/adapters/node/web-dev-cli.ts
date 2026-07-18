#!/usr/bin/env node
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { createServer as createViteServer } from 'vite';

import {
  assertLoopbackBindAllowed,
  DEFAULT_APP_SERVER_HOST,
  readAppServerPort,
  readRemoteBindOptIn,
} from './app-server-config.js';
import { createAppServerHttpProxy, serveAppServerHttpTransport } from './app-server-transport.js';
import { createProviderBackedAppServer } from './provider-runtime.js';
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
  createAppServer: async () => await createProviderBackedAppServer({ cwd: process.cwd() }),
  createTransport: async (appServer) =>
    await serveAppServerHttpTransport({
      appServer,
      host: DEFAULT_APP_SERVER_HOST,
      port: 0,
    }),
  createVite: async (transport) => {
    const proxy = createAppServerHttpProxy(transport.url, transport.capability);
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
