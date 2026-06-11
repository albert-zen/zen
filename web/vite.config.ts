import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

const defaultProxyTarget = process.env.ZEN_APP_SERVER_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
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
    proxy: createAppServerProxy(defaultProxyTarget)
  }
});

function createAppServerProxy(target: string): Record<string, ProxyOptions> {
  return {
    "/request": {
      target,
      changeOrigin: true
    },
    "/events": {
      target,
      changeOrigin: true
    }
  };
}
