import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          "app-server-host": resolve(__dirname, "src/main/app-server-host.ts"),
        },
      },
    },
  },
  preload: {},
  renderer: {
    plugins: [react()],
  },
});
