import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const providerLogoSource = await readFile(
  new URL("../src/renderer/src/ProviderLogo.tsx", import.meta.url),
  "utf8",
);

test("known Provider logos use recorded local formal SVG assets", async () => {
  for (const name of ["openai", "deepseek", "qwen"]) {
    const asset = await readFile(
      new URL(
        `../src/renderer/src/assets/providers/${name}.svg`,
        import.meta.url,
      ),
      "utf8",
    );
    assert.match(asset, /^<svg[^>]+viewBox=/u);
    assert.match(providerLogoSource, new RegExp(`${name}\\.svg`, "u"));
  }

  const sources = await readFile(
    new URL("../src/renderer/src/assets/providers/SOURCES.md", import.meta.url),
    "utf8",
  );
  assert.match(sources, /openai\.com\/brand/u);
  assert.match(sources, /deepseek-ai\/DeepSeek-VL/u);
  assert.match(sources, /QwenLM\/qwen-code/u);
  assert.match(providerLogoSource, /<img/u);
  assert.match(providerLogoSource, /kind === "local"/u);
  assert.match(providerLogoSource, /kind === "generic"/u);
  assert.doesNotMatch(providerLogoSource, /M9 2\.7|M3 10\.5|M9 2\.8/u);
});
