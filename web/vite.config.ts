import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { consumeAppServerClientHandoff, createAppServerHttpProxy } from '#zen/node';

const defaultProxyTarget = process.env.ZEN_APP_SERVER_URL ?? 'http://127.0.0.1:3000';

export default defineConfig(async ({ command }) => {
  const proxy = command === 'serve' ? await readAuthenticatedProxy() : undefined;

  return {
    root: process.cwd(),
    plugins: [react(), tailwindcss()],
    build: {
      outDir: 'web-dist',
      emptyOutDir: true,
      rollupOptions: {
        input: 'web/index.html',
      },
    },
    server: {
      cors: false,
      host: '127.0.0.1',
      port: 4174,
      strictPort: false,
      proxy,
    },
  };
});

async function readAuthenticatedProxy() {
  const capability = process.env.ZEN_APP_SERVER_CAPABILITY;
  const handoffPath = process.env.ZEN_APP_SERVER_CAPABILITY_HANDOFF;

  if (Boolean(capability) === Boolean(handoffPath)) {
    throw new Error(
      'Set exactly one of ZEN_APP_SERVER_CAPABILITY or ZEN_APP_SERVER_CAPABILITY_HANDOFF for the trusted Web proxy'
    );
  }

  if (handoffPath) {
    const handoff = await consumeAppServerClientHandoff(handoffPath);
    return createAppServerHttpProxy(handoff.baseUrl, handoff.capability);
  }

  return createAppServerHttpProxy(defaultProxyTarget, capability as string);
}
