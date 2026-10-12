import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { instrumentStartup } from "../scripts/prepare-windows-startup-acceptance.mjs";

const source = `const bootstrapFence = { run: async (f) => { calls.push("fence"); await f(); } };
const appServerManager = { status: { type: "ready" } };
async function bootstrapZenX() { calls.push("bootstrap"); }
(async () => { calls.push("window"); await bootstrapFence.run(bootstrapZenX); })();`;

for (const failure of [false, true]) {
  test(`instrumentation preserves the real fence and bootstrap, failure=${failure}`, async () => {
    const calls = [];
    const transformed = instrumentStartup(source).replace(
      /^import[^\n]+\n/u,
      "",
    );
    const context = {
      calls,
      startupAcceptanceFixture: {
        observe: () => calls.push("observe"),
        gate: async () => {
          calls.push("gate");
          if (failure) throw new Error("fixture failure");
        },
        completed: (status) => calls.push(status),
      },
    };
    const result = vm.runInNewContext(transformed, context);
    if (failure) await assert.rejects(result, /fixture failure/u);
    else await result;
    assert.deepEqual(
      calls,
      failure
        ? ["observe", "window", "fence", "gate"]
        : ["observe", "window", "fence", "gate", "bootstrap", "ready"],
    );
  });
}

test("instrumentation rejects missing, changed, duplicate and already instrumented seams", () => {
  for (const input of [
    "",
    source.replace("run(bootstrapZenX)", "run(other)"),
    source + source,
    instrumentStartup(source),
  ]) {
    assert.throws(
      () => instrumentStartup(input),
      /exactly one|already instrumented/u,
    );
  }
});

test("comments and strings cannot impersonate the awaited lifecycle seam", () => {
  assert.throws(
    () =>
      instrumentStartup(
        '// await bootstrapFence.run(bootstrapZenX);\n"await bootstrapFence.run(bootstrapZenX);";',
      ),
    /exactly one/u,
  );
  assert.throws(
    () => instrumentStartup("bootstrapFence.run(bootstrapZenX);"),
    /exactly one/u,
  );
});

test("private staging preserves the original package and refuses reused destinations", async () => {
  const { mkdtemp, mkdir, readFile, writeFile, rm } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { prepareFixture } =
    await import("../scripts/prepare-windows-startup-acceptance.mjs");
  const root = await mkdtemp(path.join(tmpdir(), "zenx-startup-stage-"));
  try {
    const original = path.join(root, "original");
    const main = path.join("resources", "app", "out", "main");
    await mkdir(path.join(original, main), { recursive: true });
    await writeFile(path.join(original, main, "index.js"), source);
    await writeFile(path.join(original, "ZenX.exe"), "synthetic-executable");
    const evidence = path.join(root, "evidence");
    await mkdir(evidence);
    const destination = path.join(root, "copy");
    await prepareFixture(original, destination, evidence, "failure");
    assert.equal(
      await readFile(path.join(original, main, "index.js"), "utf8"),
      source,
    );
    assert.equal(
      await readFile(path.join(destination, main, "index.js"), "utf8"),
      instrumentStartup(source),
    );
    assert.equal(
      await readFile(path.join(destination, "ZenX.exe"), "utf8"),
      "synthetic-executable",
    );
    const config = JSON.parse(
      await readFile(
        path.join(destination, main, "startup-acceptance-config.json"),
        "utf8",
      ),
    );
    assert.deepEqual(config, { evidenceDirectory: evidence, mode: "failure" });
    const hashes = JSON.parse(
      await readFile(path.join(evidence, "instrumentation.json"), "utf8"),
    );
    assert.notEqual(hashes.originalMainSha256, hashes.instrumentedMainSha256);
    await assert.rejects(
      prepareFixture(original, destination, evidence, "success"),
      /EEXIST/u,
    );
    await assert.rejects(
      prepareFixture(original, path.join(root, "invalid"), evidence, "other"),
      /Invalid/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fixture records Electron 43 console-message details from the first argument", async () => {
  const { readFile } = await import("node:fs/promises");
  const { EventEmitter } = await import("node:events");
  const { createRequire } = await import("node:module");
  const { default: ts } = await import("typescript");
  const fixtureUrl = new URL(
    "./fixtures/startup-acceptance/fixture.mjs",
    import.meta.url,
  );
  const source = (await readFile(fixtureUrl, "utf8")).replaceAll(
    "import.meta.url",
    JSON.stringify(fixtureUrl.href),
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2023,
      esModuleInterop: true,
    },
  }).outputText;
  const app = new EventEmitter();
  const webContents = new EventEmitter();
  const records = [];
  const exports = {};
  const realRequire = createRequire(import.meta.url);
  vm.runInNewContext(compiled, {
    exports,
    process,
    URL,
    setInterval: () => ({ unref() {} }),
    require: (name) =>
      name === "electron"
        ? { app, BrowserWindow: {} }
        : name === "node:fs"
          ? {
              readFileSync: () =>
                JSON.stringify({
                  evidenceDirectory: "/synthetic",
                  mode: "failure",
                }),
              appendFileSync: (_path, line) => records.push(JSON.parse(line)),
            }
          : realRequire(name),
  });
  exports.observe();
  app.emit(
    "browser-window-created",
    {},
    { id: 1, webContents, getNativeWindowHandle: () => Buffer.alloc(8) },
  );
  webContents.emit(
    "console-message",
    { message: "synthetic CSP rejection", level: "error" },
    3,
    "deprecated positional message",
    1,
    "file:///startup.html",
  );
  assert.deepEqual(
    records.find((record) => record.type === "renderer-console"),
    {
      type: "renderer-console",
      pid: process.pid,
      at: records.at(-1).at,
      message: "synthetic CSP rejection",
      level: "error",
    },
  );
});
