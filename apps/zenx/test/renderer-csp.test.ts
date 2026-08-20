import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadConfigFromFile } from "electron-vite";
import { build, createServer } from "vite";

const rendererIndexPath = new URL(
  "../src/renderer/index.html",
  import.meta.url,
);
const rendererRootPath = fileURLToPath(
  new URL("../src/renderer", import.meta.url),
);
const configFilePath = fileURLToPath(
  new URL("../electron.vite.config.ts", import.meta.url),
);

test("development Vite pipeline only relaxes the renderer CSP meta", async () => {
  const productionHtml = await readFile(rendererIndexPath, "utf8");
  const developmentFixture = productionHtml.replace(
    "<head>",
    `<head>
    <!-- style-src 'self' -->
    <meta name="csp-decoy" content="style-src 'self'" />`,
  );
  const loaded = await loadConfigFromFile(
    { command: "serve", mode: "development" },
    configFilePath,
  );
  const server = await createServer({
    ...loaded.config.renderer,
    configFile: false,
    logLevel: "silent",
    root: rendererRootPath,
    server: { middlewareMode: true },
  });

  try {
    const developmentHtml = await server.transformIndexHtml(
      "/index.html",
      developmentFixture,
    );

    assert.match(developmentHtml, /<!-- style-src 'self' -->/u);
    assert.match(
      developmentHtml,
      /<meta name="csp-decoy" content="style-src 'self'" \/>/u,
    );
    assert.match(
      developmentHtml,
      /http-equiv="Content-Security-Policy"[\s\S]*?content="[^"]*style-src 'self' 'unsafe-inline';/u,
    );
    assert.equal(
      developmentHtml.match(/style-src 'self' 'unsafe-inline'/gu)?.length,
      1,
    );
    assert.match(developmentHtml, /script-src 'self';/u);

    await assert.rejects(
      server.transformIndexHtml(
        "/index.html",
        productionHtml.replace(
          "style-src 'self';",
          "style-src 'self'; style-src 'self';",
        ),
      ),
      /exactly one style-src directive/u,
    );

    const cspMeta = productionHtml.match(
      /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/u,
    )?.[0];
    assert.ok(cspMeta);
    await assert.rejects(
      server.transformIndexHtml(
        "/index.html",
        productionHtml.replace(cspMeta, `${cspMeta}\n${cspMeta}`),
      ),
      /exactly one CSP meta/u,
    );
  } finally {
    await server.close();
  }
});

test("production Vite build keeps the renderer CSP strict", async () => {
  const productionHtml = await readFile(rendererIndexPath, "utf8");

  assert.match(productionHtml, /style-src 'self';/u);
  assert.doesNotMatch(productionHtml, /style-src[^;]*'unsafe-inline'/u);

  const loaded = await loadConfigFromFile(
    { command: "build", mode: "production" },
    configFilePath,
  );
  const result = await build({
    ...loaded.config.renderer,
    configFile: false,
    logLevel: "silent",
    root: rendererRootPath,
    build: { ...loaded.config.renderer?.build, write: false },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(
    (entry) => ("output" in entry ? entry.output : []),
  );
  const indexHtml = outputs.find(
    (entry) => entry.type === "asset" && entry.fileName === "index.html",
  );

  assert.ok(indexHtml && indexHtml.type === "asset");
  const builtHtml = String(indexHtml.source);
  assert.match(builtHtml, /style-src 'self';/u);
  assert.doesNotMatch(builtHtml, /style-src[^;]*'unsafe-inline'/u);
  assert.match(builtHtml, /script-src 'self';/u);
});
