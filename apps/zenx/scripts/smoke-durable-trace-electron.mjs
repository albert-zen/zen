import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { build } from "vite";
import { waitForSmokeProcess } from "./workspace-browser-persistence-smoke.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
assert(process.argv[2], "Pass a private CI evidence directory");
const directory = path.resolve(process.argv[2]);
const buildOnly = process.argv[3] === "--build-only";
assert(process.argv[3] === undefined || buildOnly, "Unknown smoke option");
await mkdir(directory, { recursive: true });
const sourcePaths = [
  "src/main/model-request-debug-electron.ts",
  "src/main/model-request-debug-ipc.ts",
  "src/main/imzenx-setup-ipc.ts",
  "src/main/index.ts",
  "src/preload/ipc.ts",
  "test/fixtures/durable-trace-electron-main.ts",
  "test/fixtures/durable-trace-electron-preload.cjs",
  "scripts/smoke-durable-trace-electron.mjs",
  "../cli/src/model-request-debug.ts",
  "../../src/trace.ts",
];
await build({
  configFile: false,
  root,
  logLevel: "warn",
  build: {
    ssr: path.join(root, "test/fixtures/durable-trace-electron-main.ts"),
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
await copyFile(
  path.join(root, "test/fixtures/durable-trace-electron-preload.cjs"),
  path.join(directory, "preload.cjs"),
);
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
          sourcePaths.map(async (file) => [
            file,
            await hash(path.join(root, file)),
          ]),
        ),
      ),
      bundles: {
        main: await hash(path.join(directory, "main.cjs")),
        preload: await hash(path.join(directory, "preload.cjs")),
      },
    },
    null,
    2,
  ) + "\n",
);
if (!buildOnly) {
  assert.equal(
    process.env.GITHUB_ACTIONS,
    "true",
    "Native invocation runs only on disposable cloud CI",
  );
  assert.equal(
    process.platform,
    "darwin",
    "Use the existing native macOS CI job",
  );
  const privateDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-native-trace-gate-"),
  );
  let cleanupSafe = true;
  try {
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      electron,
      [path.join(directory, "main.cjs"), directory, privateDirectory],
      { env: environment, stdio: "inherit" },
    );
    const code = await waitForSmokeProcess(child).catch((error) => {
      cleanupSafe = error.reaped;
      throw error;
    });
    assert.equal(code, 0, "Native Trace frame gate must pass");
    const result = JSON.parse(
      await readFile(path.join(directory, "result.json"), "utf8"),
    );
    assert.equal(result.ok, true);
    assert.equal(result.cases.length, 12);
    assert.equal(result.readerCalls, 4);
    console.log(
      "PASS: 12 real Electron Trace payload/artifact frame assertions; denied frames never reached the durable reader.",
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
