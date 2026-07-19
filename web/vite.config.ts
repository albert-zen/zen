import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

import { consumeAppServerClientHandoff, createAgentAppHttpProxy } from '#zen/node';

const defaultProxyTarget = process.env.ZEN_APP_SERVER_URL ?? 'http://127.0.0.1:3000';

export default defineConfig(async ({ command }) => {
  const proxy = command === 'serve' ? await readAuthenticatedProxy() : undefined;
  const workspaceRoot = process.cwd();

  return {
    root: resolve(workspaceRoot, 'web'),
    plugins: [react(), tailwindcss()],
    build: {
      outDir: resolve(workspaceRoot, 'web-dist'),
      emptyOutDir: true,
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
    return createAgentAppHttpProxy(handoff.baseUrl, handoff.capability);
  }

  return createAgentAppHttpProxy(defaultProxyTarget, capability as string);
}
