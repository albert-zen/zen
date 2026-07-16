import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@zen/product": new URL("./src/product/index.ts", import.meta.url).pathname,
      "@zen/presentation": new URL("./src/presentation/index.ts", import.meta.url).pathname
    }
  },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"]
  }
});
