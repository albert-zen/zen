import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { consumeAppServerClientHandoff } from "../src/app-server-config.js";
import { createAppServerHttpProxy } from "../src/app-server-transport.js";

const defaultProxyTarget = process.env.ZEN_APP_SERVER_URL ?? "http://127.0.0.1:3000";

export default defineConfig(async ({ command }) => {
  const proxy =
    command === "serve" ? await readAuthenticatedProxy() : undefined;

  return {
    root: process.cwd(),
    plugins: [react(), tailwindcss()],
    build: {
      outDir: "web-dist",
      emptyOutDir: true,
      rollupOptions: {
        input: "web/index.html"
      }
    },
    server: {
      host: "127.0.0.1",
      port: 4174,
      strictPort: false,
      proxy
    }
  };
});

async function readAuthenticatedProxy() {
  const capability = process.env.ZEN_APP_SERVER_CAPABILITY;

  if (capability) {
    return createAppServerHttpProxy(defaultProxyTarget, capability);
  }

  const handoffPath = process.env.ZEN_APP_SERVER_CAPABILITY_FILE;

  if (handoffPath) {
    const handoff = await consumeAppServerClientHandoff(handoffPath);
    return createAppServerHttpProxy(handoff.baseUrl, handoff.capability);
  }

  throw new Error(
    "Set ZEN_APP_SERVER_CAPABILITY or ZEN_APP_SERVER_CAPABILITY_FILE for the trusted Web proxy"
  );
}
