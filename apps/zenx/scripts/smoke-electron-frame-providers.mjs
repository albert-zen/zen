import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
assert(process.argv[2], "Pass a private CI evidence directory");
const directory = path.resolve(process.argv[2]);
const buildOnly = process.argv[3] === "--build-only";
assert(process.argv[3] === undefined || buildOnly, "Unknown smoke option");
await mkdir(directory, { recursive: true });
const sources = [
  "src/main/capabilities/browser-provider.ts",
  "src/main/capabilities/browser-targeted-input.ts",
  "src/main/capabilities/browser-frame-input.ts",
  "src/main/capabilities/browser-frame-evidence.ts",
  "src/main/capabilities/browser-frame-geometry.ts",
  "src/main/workspace-browser.ts",
  "src/main/workspace-browser-electron.ts",
  "src/main/workspace-browser-renderer.ts",
  "src/main/browser-remote-frame-smoke-fixture.ts",
  "test/fixtures/electron-frame-providers-main.ts",
  "test/fixtures/electron-frame-provider-evidence.ts",
  "scripts/smoke-electron-frame-providers.mjs",
];
await build({
  configFile: false,
  root,
  logLevel: "warn",
  build: {
    ssr: path.join(root, "test/fixtures/electron-frame-providers-main.ts"),
    outDir: directory,
    emptyOutDir: false,
    minify: false,
    rollupOptions: {
      external: [
        "electron",
        ...builtinModules,
        ...builtinModules.map((name) => `node:${name}`),
      ],
      output: {
        format: "cjs",
        entryFileNames: "main.cjs",
        inlineDynamicImports: true,
      },
    },
  },
});
const hash = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
await writeFile(
  path.join(directory, "source.json"),
  JSON.stringify(
    {
      commit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      trackedChanges: execFileSync("git", ["diff", "--name-only", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .filter(Boolean),
      sources: Object.fromEntries(
        await Promise.all(
          sources.map(async (file) => [
            file,
            await hash(path.join(root, file)),
          ]),
        ),
      ),
      bundle: await hash(path.join(directory, "main.cjs")),
    },
    null,
    2,
  ) + "\n",
);
if (!buildOnly) {
  assert.equal(
    process.env.GITHUB_ACTIONS,
    "true",
    "Native invocation runs only on disposable hosted CI",
  );
  assert.equal(
    process.platform,
    "darwin",
    "Use the existing native macOS CI job",
  );
  const { default: electron } = await import("electron");
  const { waitForSmokeProcess } =
    await import("./workspace-browser-persistence-smoke.mjs");
  const privateDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-electron-frame-providers-"),
  );
  let cleanupSafe = true;
  try {
    await mkdir(path.join(privateDirectory, "profile"));
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      electron,
      [path.join(directory, "main.cjs"), directory, privateDirectory],
      { env: environment, stdio: "inherit" },
    );
    const code = await waitForSmokeProcess(child, 180_000).catch((error) => {
      cleanupSafe = error.reaped;
      throw error;
    });
    assert.equal(
      code,
      0,
      "Native production-provider frame acceptance must pass",
    );
    const result = JSON.parse(
      await readFile(path.join(directory, "result.json"), "utf8"),
    );
    assert.equal(result.ok, true);
    assert.equal(result.cases.length, 4);
    for (const entry of result.cases) {
      assert.equal(entry.status, "passed");
      assert.equal(entry.physicallyClosed, true);
    }
    console.log(
      "PASS: real WorkspaceBrowser and ElectronBrowserBackend mixed/nested remote-frame input, stale focus and isolated quarantine.",
    );
  } finally {
    if (cleanupSafe)
      await rm(privateDirectory, { recursive: true, force: true });
    else
      console.error(
        `Retained unclosed synthetic Electron profile: ${privateDirectory}`,
      );
  }
}
