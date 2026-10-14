import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { createModelDiagnosticWriter } from "../../../apps/cli/src/model-diagnostics.js";
import { ipcChannels } from "../src/preload/ipc.js";

const require = createRequire(import.meta.url);
const preloadPath = fileURLToPath(
  new URL("../src/preload/index.ts", import.meta.url),
);
const preload = await build({
  entryPoints: [preloadPath],
  bundle: true,
  format: "cjs",
  platform: "node",
  packages: "external",
  write: false,
});
function runBundle(code: string, electron: unknown) {
  const module = { exports: {} };
  new Function(
    "require",
    "module",
    "exports",
    "process",
    "__dirname",
    "__filename",
    code,
  )(
    (name: string) => (name === "electron" ? electron : require(name)),
    module,
    module.exports,
    process,
    path.dirname(preloadPath),
    preloadPath,
  );
  return module.exports;
}

test("preload preserves the model diagnostic source instead of opening Settings logs", async () => {
  let exposed!: Window["zenx"];
  const calls: unknown[][] = [];
  runBundle(preload.outputFiles![0]!.text, {
    contextBridge: {
      exposeInMainWorld(_name: string, api: Window["zenx"]) {
        exposed = api;
      },
    },
    ipcRenderer: {
      async invoke(...args: unknown[]) {
        calls.push(args);
      },
    },
  });
  await (
    exposed.settings.openDiagnosticsFolder as (source?: string) => Promise<void>
  )("model");
  assert.deepEqual(calls, [
    [ipcChannels.settingsDiagnosticsOpenFolder, "model"],
  ]);
});

const main = await build({
  entryPoints: [
    fileURLToPath(
      new URL("../src/main/diagnostics-folder-ipc.ts", import.meta.url),
    ),
  ],
  bundle: true,
  format: "cjs",
  platform: "node",
  packages: "external",
  write: false,
});
test("model diagnostics open the persisted log directory while Settings retain their own directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-diagnostic-folder-"));
  try {
    const locations = {
      modelDirectory: path.join(root, "zen-data", "diagnostics"),
      settingsDirectory: path.join(root, "app-data", "diagnostics"),
    };
    await createModelDiagnosticWriter(locations.modelDirectory)({
      timestamp: new Date().toISOString(),
      diagnosticId: "diagnostic-1",
      model: "fixture",
      status: 400,
      payloadIndex: 1,
    });
    let handler!: (event: unknown, source?: unknown) => Promise<void>;
    let exposed!: Window["zenx"];
    let opened = "";
    let shellError = "";
    const electron = {
      ipcMain: {
        handle(channel: string, callback: typeof handler) {
          assert.equal(channel, ipcChannels.settingsDiagnosticsOpenFolder);
          handler = callback;
        },
      },
      ipcRenderer: {
        async invoke(channel: string, ...args: unknown[]) {
          assert.equal(channel, ipcChannels.settingsDiagnosticsOpenFolder);
          return handler({}, ...args);
        },
      },
      contextBridge: {
        exposeInMainWorld(_name: string, api: Window["zenx"]) {
          exposed = api;
        },
      },
      shell: {
        async openPath(directory: string) {
          opened = directory;
          return shellError;
        },
      },
    };
    const register = runBundle(
      main.outputFiles![0]!.text,
      electron,
    ) as typeof import("../src/main/diagnostics-folder-ipc.js");
    register.registerDiagnosticsFolderIpc(locations);
    runBundle(preload.outputFiles![0]!.text, electron);
    await exposed.settings.openDiagnosticsFolder("model");
    assert.equal(opened, locations.modelDirectory);
    assert.match(
      await readFile(path.join(opened, "model-stream-errors.jsonl"), "utf8"),
      /diagnostic-1/u,
    );
    await exposed.settings.openDiagnosticsFolder();
    assert.equal(opened, locations.settingsDirectory);
    await assert.rejects(
      handler({}, "/arbitrary/path"),
      /Invalid diagnostics source/u,
    );
    await assert.rejects(
      handler({}, { source: "remote", path: locations.modelDirectory }),
      /Invalid diagnostics source/u,
    );
    shellError = "operating system refused";
    await assert.rejects(
      exposed.settings.openDiagnosticsFolder("model"),
      /Could not open diagnostics folder/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
