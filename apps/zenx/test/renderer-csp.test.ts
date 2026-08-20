import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { loadConfigFromFile } from "electron-vite";
import type { Plugin } from "vite";

const rendererIndexPath = new URL(
  "../src/renderer/index.html",
  import.meta.url,
);
const configPath = new URL("../electron.vite.config.ts", import.meta.url);

test("keeps production styles strict while allowing Vite development injection", async () => {
  const productionHtml = await readFile(rendererIndexPath, "utf8");

  assert.match(productionHtml, /style-src 'self';/u);
  assert.doesNotMatch(productionHtml, /style-src[^;]*'unsafe-inline'/u);
  const loaded = await loadConfigFromFile(
    { command: "serve", mode: "development" },
    configPath.pathname,
  );
  const plugin = loaded.config.renderer?.plugins?.find(
    (candidate) =>
      candidate !== false &&
      candidate !== null &&
      candidate !== undefined &&
      typeof candidate === "object" &&
      "name" in candidate &&
      candidate.name === "zenx-vite-development-csp",
  ) as Plugin | undefined;
  assert.ok(plugin && typeof plugin === "object");
  assert.equal(plugin.apply, "serve");
  const transformIndexHtml = plugin.transformIndexHtml;
  assert.equal(typeof transformIndexHtml, "function");

  const developmentHtml = await (
    transformIndexHtml as (html: string) => string | Promise<string>
  )(productionHtml);
  assert.match(developmentHtml, /style-src 'self' 'unsafe-inline';/u);
  assert.match(developmentHtml, /script-src 'self';/u);
});
