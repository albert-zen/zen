import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import type { Plugin } from "vite";

const productionStylePolicy = "style-src 'self'";
const developmentStylePolicy = "style-src 'self' 'unsafe-inline'";

function allowViteDevelopmentStyles(html: string): string {
  if (!html.includes(productionStylePolicy)) {
    throw new Error("ZenX renderer CSP is missing its production style policy");
  }
  return html.replace(productionStylePolicy, developmentStylePolicy);
}

const viteDevelopmentCsp: Plugin = {
  name: "zenx-vite-development-csp",
  apply: "serve",
  transformIndexHtml: allowViteDevelopmentStyles,
};

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          "app-server-host": resolve(__dirname, "src/main/app-server-host.ts"),
          "capability-smoke": resolve(
            __dirname,
            "src/main/capability-smoke.ts",
          ),
          "packaged-provider-smoke": resolve(
            __dirname,
            "src/main/packaged-provider-smoke.ts",
          ),
          "real-smoke": resolve(__dirname, "src/main/real-smoke.ts"),
          "provider-smoke": resolve(__dirname, "src/main/provider-smoke.ts"),
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },
  renderer: {
    plugins: [viteDevelopmentCsp, react()],
  },
});
