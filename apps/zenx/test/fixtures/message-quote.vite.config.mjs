import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL("../../", import.meta.url)),
  base: "./",
  plugins: [react()],
  build: {
    outDir: process.env.ZENX_QUOTE_PREVIEW_OUT ?? "/tmp/zenx-quote-preview",
    emptyOutDir: true,
    assetsInlineLimit: 10000000,
    rollupOptions: {
      input: fileURLToPath(
        new URL("./message-quote-visual.html", import.meta.url),
      ),
      output: { inlineDynamicImports: true },
    },
  },
});
