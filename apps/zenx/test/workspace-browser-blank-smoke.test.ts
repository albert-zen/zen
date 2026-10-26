import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

// Execute the actual smoke function with only its native I/O boundary replaced.
// These are orchestration tests, not evidence of real Electron pixels.
const source = readFileSync(
  new URL("../src/main/workspace-browser-smoke.ts", import.meta.url),
  "utf8",
);
const parsed = ts.createSourceFile(
  "smoke.ts",
  source,
  ts.ScriptTarget.Latest,
  true,
);
const declaration = parsed.statements.find(
  (node) =>
    ts.isFunctionDeclaration(node) &&
    node.name?.text === "assertBlankThemePixels",
);
assert.ok(declaration);
const script = ts.transpileModule(declaration.getText(parsed), {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
  },
}).outputText;

function fixture(inspectionGate: Promise<void> = Promise.resolve()) {
  let url = "about:blank";
  let appearance = "light";
  let inspectCount = 0;
  let shutdowns = 0;
  let destroyed = 0;
  let directCaptures = 0;
  const mounts: any[] = [];
  const writes = new Map<string, string | Buffer>();
  const images = new Map<string, number>();
  const view = {
    webContents: {
      id: 7,
      executeJavaScript: async () => false,
      getURL: () => url,
      capturePage: () => {
        directCaptures++;
        throw new Error("Direct capture has no freshness gate");
      },
    },
  };
  const owner = {
    webContents: {},
    contentView: { children: [] as any[] },
    loadURL: async () => {},
    showInactive: () => {},
    destroy: () => {
      destroyed++;
    },
  };
  const browser = {
    bindThreadSession: () => {},
    open: async () => ({ tabId: "same-tab" }),
    navigate: async (_session: string, tabId: string, value: string) => {
      assert.equal(tabId, "same-tab");
      url = value;
    },
    mount: (_sender: unknown, request: any) => {
      mounts.push(request);
      appearance = request.appearance;
      owner.contentView.children = [view];
    },
    inspect: async (session: string, tabId: string) => {
      inspectCount++;
      assert.equal(session, "blank-theme-session");
      assert.equal(tabId, "same-tab");
      await inspectionGate;
      const artifactPath = `sample-${inspectCount}`;
      images.set(
        artifactPath,
        url === "about:blank" ? (appearance === "dark" ? 0 : 255) : 80,
      );
      return {
        tabId,
        observationId: `observed-${inspectCount}`,
        screenshot: { artifactPath },
      };
    },
    shutdown: async () => {
      shutdowns++;
    },
  };
  const run = runInNewContext(`${script}; assertBlankThemePixels`, {
    assert,
    path,
    process: {
      env: {
        ZENX_BROWSER_BLANK_ARTIFACT_DIR: "/evidence",
        GITHUB_SHA: "exact-head",
      },
    },
    BrowserWindow: function () {
      return owner;
    },
    createElectronWorkspaceBrowser: (options: any) => {
      options.onCreateView(view);
      return browser;
    },
    nativeTheme: { themeSource: "system", shouldUseDarkColors: false },
    nativeImage: {
      createFromBuffer: (buffer: Buffer) => ({
        isEmpty: () => false,
        getSize: () => ({ width: 1, height: 1 }),
        toBitmap: () => Buffer.from([buffer[0]!, buffer[0]!, buffer[0]!, 255]),
      }),
    },
    readFileSync: (file: string) => {
      assert.ok(images.has(file));
      return Buffer.from([images.get(file)!]);
    },
    mkdirSync: () => {},
    writeFileSync: (file: string, content: string | Buffer) => {
      writes.set(file, content);
    },
    console: { log: () => {} },
    AggregateError,
    Error,
  });
  return {
    run: () => run(4321),
    mounts,
    writes,
    counts: () => ({ inspectCount, shutdowns, destroyed, directCaptures }),
    receipt: () => JSON.parse(String(writes.get("/evidence/receipt.json"))),
  };
}

test("blank smoke waits for each production inspection, preserves target/lease, and writes eight native artifacts", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(gate);
  const running = f.run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.counts().inspectCount, 1);
  assert.equal(
    f.writes.size,
    0,
    "no screenshot is recorded before product capture completes",
  );
  release();
  await running;
  assert.deepEqual(f.counts(), {
    inspectCount: 8,
    shutdowns: 1,
    destroyed: 1,
    directCaptures: 0,
  });
  assert.equal(new Set(f.mounts.map((mount) => mount.lease)).size, 1);
  assert.equal(new Set(f.mounts.map((mount) => mount.tabId)).size, 1);
  assert.equal(
    new Set(f.mounts.map((mount) => JSON.stringify(mount.bounds))).size,
    1,
  );
  assert.deepEqual(
    f.mounts.map((mount) => mount.appearance),
    ["light", "dark", "light", "light", "dark", "dark", "light", "dark"],
  );
  const receipt = f.receipt();
  assert.equal(receipt.passed, true);
  assert.equal(receipt.head, "exact-head");
  assert.deepEqual(
    receipt.records.map((record: any) => record.pixel),
    [255, 0, 255, 255, 0, 80, 80, 0].map((value) => [value, value, value, 255]),
  );
  assert.ok(
    receipt.records.every(
      (record: any) => record.status === "verified" && record.observationId,
    ),
  );
  assert.equal(
    [...f.writes.keys()].filter((file) => file.endsWith(".png")).length,
    8,
  );
});

for (const message of [
  "UnknownVizError",
  "Browser native capture timed out; inspect again",
]) {
  test(`blank smoke preserves ${message} with phase receipt and no retry`, async () => {
    const failure = new Error(message);
    const gate = Promise.reject(failure);
    void gate.catch(() => {});
    const f = fixture(gate);
    await assert.rejects(f.run(), (error) => error === failure);
    assert.deepEqual(f.counts(), {
      inspectCount: 1,
      shutdowns: 1,
      destroyed: 1,
      directCaptures: 0,
    });
    const receipt = f.receipt();
    assert.equal(receipt.passed, false);
    assert.equal(receipt.phase, "blank-light");
    assert.equal(receipt.records[0].status, "inspecting");
    assert.deepEqual(receipt.failure, [message]);
    assert.equal(
      [...f.writes.keys()].filter((file) => file.endsWith(".png")).length,
      0,
    );
  });
}
