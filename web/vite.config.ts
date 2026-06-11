import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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
    strictPort: false
  }
});
