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

async function loadObserverFixture(windows = []) {
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
  const records = [];
  const writes = [];
  const exports = {};
  const realRequire = createRequire(import.meta.url);
  const timers = new Set();
  vm.runInNewContext(compiled, {
    exports,
    process,
    URL,
    AbortSignal,
    setInterval: () => ({ unref() {} }),
    setTimeout(callback, milliseconds) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        callback();
      }, milliseconds);
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) {
      timers.delete(timer);
      clearTimeout(timer);
    },
    require: (name) =>
      name === "electron"
        ? { app, BrowserWindow: { getAllWindows: () => windows } }
        : name === "node:fs"
          ? {
              readFileSync: () =>
                JSON.stringify({
                  evidenceDirectory: "/synthetic",
                  mode: "failure",
                }),
              appendFileSync: (_path, line) => records.push(JSON.parse(line)),
              writeFileSync: (path, bytes) => writes.push({ path, bytes }),
            }
          : realRequire(name),
  });
  exports.observe();
  return { app, records, writes, EventEmitter, exports, timers };
}

test("fixture records Electron 43 console-message details from the first argument", async () => {
  const { app, records, EventEmitter } = await loadObserverFixture();
  const webContents = new EventEmitter();
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

test("startup capture waits for the real show event after did-finish-load", async () => {
  const { app, records, writes, EventEmitter } = await loadObserverFixture();
  const window = new EventEmitter();
  const webContents = new EventEmitter();
  let visible = false;
  let captures = 0;
  Object.assign(window, {
    id: 1,
    webContents,
    getNativeWindowHandle: () => Buffer.alloc(8),
    isVisible: () => visible,
  });
  Object.assign(webContents, {
    getURL: () => "file:///startup.html",
    executeJavaScript: async () => ({
      role: "status",
      text: "Starting fixture",
    }),
    capturePage: async () => {
      captures++;
      if (!visible) throw new Error("UnknownVizError before show");
      return { toPNG: () => Buffer.from("synthetic-png") };
    },
  });
  app.emit("browser-window-created", {}, window);
  webContents.emit("did-finish-load");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    captures,
    0,
    "DOM load does not guarantee a visible compositor surface",
  );
  assert.equal(
    records.some((record) => record.type === "startup-page-observed"),
    true,
  );
  assert.equal(
    records.some((record) => record.type === "startup-loaded"),
    false,
  );
  visible = true;
  window.emit("show");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(captures, 1);
  assert.equal(writes.length, 1);
  assert.equal(
    records.find((record) => record.type === "startup-loaded")?.visible,
    true,
  );
  assert.equal(
    records.some((record) => record.type === "fixture-error"),
    false,
  );
});

function presentedImage({
  width = 100,
  height = 80,
  painted = false,
  empty = false,
} = {}) {
  const bytes = Buffer.alloc(width * height * 4);
  for (let i = 0; i < bytes.length; i += 4) bytes.set([232, 234, 241, 255], i);
  if (painted)
    for (const top of [12, 57])
      for (let y = top; y < top + 3; y++)
        for (let x = 27; x < 30; x++)
          bytes.set([24, 25, 26, 255], (y * width + x) * 4);
  return {
    isEmpty: () => empty,
    getSize: () => ({ width, height }),
    toBitmap: () => bytes,
    toPNG: () =>
      Buffer.from(painted ? "presented-product-frame" : "unpainted-canvas"),
  };
}
function visibleRenderer() {
  return {
    ready: true,
    width: 100,
    height: 80,
    dpr: 1,
    controls: [
      {
        selector: ".new-thread-action",
        textPresent: true,
        x: 10,
        y: 10,
        width: 30,
        height: 15,
        textRects: [{ x: 25, y: 10, width: 12, height: 15 }],
      },
      {
        selector: ".settings-nav-row",
        textPresent: true,
        x: 10,
        y: 55,
        width: 30,
        height: 15,
        textRects: [{ x: 25, y: 55, width: 12, height: 15 }],
      },
    ],
  };
}
async function rendererFixture() {
  const windows = [];
  const fixture = await loadObserverFixture(windows);
  const window = new fixture.EventEmitter();
  const contents = new fixture.EventEmitter();
  let callback;
  const state = {
    url: "file:///index.html",
    loading: false,
    visible: true,
    cleanups: 0,
    captures: 0,
  };
  Object.assign(contents, {
    getURL: () => state.url,
    isLoadingMainFrame: () => state.loading,
    executeJavaScript: async () => visibleRenderer(),
    beginFrameSubscription: (dirty, observer) => {
      assert.equal(dirty, false);
      callback = observer;
    },
    endFrameSubscription: () => {
      state.cleanups++;
    },
    capturePage: async () => {
      state.captures++;
      return presentedImage();
    },
  });
  Object.assign(window, {
    id: 1,
    webContents: contents,
    isVisible: () => state.visible,
    getNativeWindowHandle: () => Buffer.alloc(8),
  });
  windows.push(window);
  return {
    ...fixture,
    window,
    contents,
    state,
    present: (image = presentedImage()) => callback?.(image),
    flush: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

test("mounted DOM plus the observed uniform canvas cannot publish renderer acceptance; a later product frame can", async () => {
  const f = await rendererFixture();
  f.exports.completed("ready");
  await f.flush();
  f.present(presentedImage());
  await f.flush();
  assert.equal(
    f.records.some((event) => event.type === "renderer-loaded"),
    false,
    "mounted DOM must not certify the blank screenshot",
  );
  assert.equal(
    f.writes.some((write) => write.path.endsWith("renderer-loaded.png")),
    false,
  );
  const frame = presentedImage({ painted: true });
  f.present(frame);
  await f.flush();
  const accepted = f.records.find((event) => event.type === "renderer-loaded");
  assert.equal(accepted?.hostStatus, "ready");
  assert.equal(accepted?.presentation.source, "frame-subscription");
  assert.equal(accepted?.presentation.controls.length, 2);
  assert.deepEqual(
    f.writes.find((write) => write.path.endsWith("renderer-loaded.png"))?.bytes,
    frame.toPNG(),
  );
  assert.equal(
    f.state.captures,
    0,
    "save the verified presentation frame, never recapture another frame",
  );
  assert.equal(f.state.cleanups, 1);
  assert.equal(f.contents.listenerCount("did-start-navigation"), 0);
  assert.equal(f.contents.listenerCount("render-process-gone"), 0);
  assert.equal(f.window.listenerCount("closed"), 0);
});

test("renderer bitmap acceptance fails closed on empty/flat frames or missing, hidden, misplaced and unpainted controls", async () => {
  const { exports } = await loadObserverFixture();
  const validate = exports.rendererFrameEvidence;
  assert.equal(validate(presentedImage(), visibleRenderer()), null);
  assert.equal(
    validate(presentedImage({ empty: true }), visibleRenderer()),
    null,
  );
  for (const mutate of [
    (state) => {
      state.ready = false;
    },
    (state) => {
      state.width = 0;
    },
    (state) => {
      state.controls.pop();
    },
    (state) => {
      state.controls[0].textPresent = false;
    },
    (state) => {
      state.controls[0].selector = ".unrelated";
    },
    (state) => {
      state.controls[0].x = -1;
    },
    (state) => {
      state.controls[0].width = Infinity;
    },
    (state) => {
      state.controls[0].x = 50;
    },
  ]) {
    const state = visibleRenderer();
    mutate(state);
    assert.equal(validate(presentedImage({ painted: true }), state), null);
  }
  const transparent = presentedImage({ painted: true });
  for (let offset = 3; offset < transparent.toBitmap().length; offset += 4)
    transparent.toBitmap()[offset] = 0;
  assert.equal(validate(transparent, visibleRenderer()), null);
  assert(validate(presentedImage({ painted: true }), visibleRenderer()));
});

for (const failure of [
  "timeout",
  "navigation",
  "closed",
  "crashed",
  "query-rejected",
  "bitmap-rejected",
  "cleanup-rejected",
]) {
  test(`presentation acceptance cleans its observers and fails closed: ${failure}`, async () => {
    const f = await rendererFixture();
    if (failure === "query-rejected")
      f.contents.executeJavaScript = async () => {
        throw new Error("query rejected");
      };
    if (failure === "cleanup-rejected")
      f.contents.endFrameSubscription = () => {
        f.state.cleanups++;
        throw new Error("cleanup rejected");
      };
    const pending = f.exports.captureRenderedApp(
      f.window,
      Date.now() + (failure === "timeout" ? 20 : 1000),
    );
    const rejected = assert.rejects(pending);
    await f.flush();
    if (failure === "timeout") f.present();
    else if (failure === "navigation") {
      f.present();
      await f.flush();
      f.contents.emit("did-start-navigation", { isMainFrame: true });
    } else if (failure === "closed") f.window.emit("closed");
    else if (failure === "crashed") f.contents.emit("render-process-gone");
    else if (failure === "bitmap-rejected")
      f.present({
        ...presentedImage({ painted: true }),
        toBitmap() {
          throw new Error("bitmap rejected");
        },
      });
    else f.present(presentedImage({ painted: true }));
    await rejected;
    assert.equal(f.state.cleanups, failure === "query-rejected" ? 0 : 1);
    assert.equal(f.timers.size, 0);
    assert.equal(f.contents.listenerCount("did-start-navigation"), 0);
    assert.equal(f.contents.listenerCount("render-process-gone"), 0);
    assert.equal(f.window.listenerCount("closed"), 0);
    f.present(presentedImage({ painted: true }));
    await f.flush();
    assert.equal(
      f.writes.some((write) => write.path.endsWith("renderer-loaded.png")),
      false,
    );
  });
}

test("a queued final presentation is not lost while a prior blank-frame DOM observation is pending", async () => {
  const f = await rendererFixture();
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  let block = false;
  f.contents.executeJavaScript = async () => {
    if (block) await blocked;
    return visibleRenderer();
  };
  const pending = f.exports.captureRenderedApp(f.window, Date.now() + 1000);
  await f.flush();
  block = true;
  f.present();
  const final = presentedImage({ painted: true });
  f.present(final);
  release();
  const result = await pending;
  assert.equal(result.image, final);
  assert.equal(f.state.cleanups, 1);
});

for (const state of [
  "visible",
  "missing",
  "hidden",
  "empty-text",
  "offscreen",
  "occluded",
  "hidden-label",
  "transparent-text",
  "transparent-fill",
  "zero-font",
  "label-occluded",
  "range-outside-label",
  "empty-range",
]) {
  test(`actual DOM observation requires visible whitelisted product text: ${state}`, async () => {
    const f = await rendererFixture();
    const rect = (x, y, width, height) => ({
      x,
      y,
      left: x,
      top: y,
      width,
      height,
      right: x + width,
      bottom: y + height,
    });
    const shell = {
      checkVisibility: () => true,
      getBoundingClientRect: () => rect(0, 0, 100, 80),
    };
    const labels = [];
    const controls = visibleRenderer().controls.map((control) => {
      const text = {
        nodeType: 3,
        textContent:
          state === "empty-text" ? " " : "Synthetic fixed control label",
        rect: rect(
          state === "range-outside-label" ? 12 : 25,
          control.y,
          12,
          15,
        ),
      };
      const label = {
        firstChild: text,
        childNodes: [text],
        checkVisibility: () => state !== "hidden-label",
        getBoundingClientRect: () => rect(25, control.y, 15, 15),
        contains: (topmost) => topmost === label && state !== "label-occluded",
      };
      labels.push(label);
      return {
        checkVisibility: () => state !== "hidden",
        getBoundingClientRect: () =>
          rect(
            state === "offscreen" ? -10 : control.x,
            control.y,
            control.width,
            control.height,
          ),
        querySelector: () => label,
      };
    });
    f.contents.executeJavaScript = async (code) =>
      vm.runInNewContext(code, {
        innerWidth: 100,
        innerHeight: 80,
        devicePixelRatio: 1,
        visualViewport: null,
        Node: { TEXT_NODE: 3 },
        getComputedStyle: () => ({
          visibility: "visible",
          opacity: "1",
          fontSize: state === "zero-font" ? "0px" : "12px",
          color:
            state === "transparent-text"
              ? "rgba(0, 0, 0, 0)"
              : "rgb(24, 25, 26)",
          webkitTextFillColor:
            state === "transparent-fill" ? "transparent" : "rgb(24, 25, 26)",
          font: "12px system-ui",
          letterSpacing: "normal",
          transform: "none",
        }),
        document: {
          visibilityState: "visible",
          querySelector(selector) {
            if (selector === ".app-shell") return shell;
            if (state === "missing") return null;
            return controls[selector.includes("new-thread-action") ? 0 : 1];
          },
          elementFromPoint: (_x, y) =>
            state === "occluded" ? {} : labels[y < 40 ? 0 : 1],
          createRange() {
            let node;
            return {
              selectNodeContents(value) {
                node = value;
              },
              getClientRects: () =>
                state === "empty-range" ? [] : [node.rect],
            };
          },
        },
      });
    const pending = f.exports.captureRenderedApp(f.window, Date.now() + 30);
    const checked = state === "visible" ? pending : assert.rejects(pending);
    await f.flush();
    f.present(presentedImage({ painted: true }));
    const result = await checked;
    if (state === "visible") {
      assert(result.evidence);
      assert.equal(
        JSON.stringify(result.evidence).includes(
          "Synthetic fixed control label",
        ),
        false,
      );
    }
    assert.equal(f.state.cleanups, state === "visible" ? 1 : 0);
    assert.equal(f.timers.size, 0);
  });
}

test("R1: a newer blank presentation invalidates an old painted frame while its DOM query is pending", async () => {
  const f = await rendererFixture();
  let release;
  let block = false;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  f.contents.executeJavaScript = async () => {
    if (block) await blocked;
    return visibleRenderer();
  };
  let accepted;
  const pending = f.exports.captureRenderedApp(f.window, Date.now() + 1000);
  void pending.then((value) => {
    accepted = value;
  });
  await f.flush();
  block = true;
  f.present(presentedImage({ painted: true }));
  f.present(presentedImage());
  release();
  await f.flush();
  assert.equal(
    accepted,
    undefined,
    "an obsolete frame cannot borrow later DOM readiness",
  );
  const final = presentedImage({ painted: true });
  f.present(final);
  assert.equal((await pending).image, final);
});

test("R1: icon pixels outside the text-node Range cannot certify visible text", async () => {
  const { exports } = await loadObserverFixture();
  const observation = visibleRenderer();
  for (const control of observation.controls)
    control.textRects = [{ x: 25, y: control.y, width: 12, height: 15 }];
  const iconOnly = presentedImage();
  for (const y of [12, 57])
    iconOnly.toBitmap().set([24, 25, 26, 255], (y * 100 + 12) * 4);
  assert.equal(exports.rendererFrameEvidence(iconOnly, observation), null);
  // Even isolated points inside the text range do not count as painted text.
  for (const y of [12, 57])
    iconOnly.toBitmap().set([24, 25, 26, 255], (y * 100 + 27) * 4);
  assert.equal(exports.rendererFrameEvidence(iconOnly, observation), null);
});

for (const change of ["layout", "dpr", "viewport", "text-style", "shell"]) {
  test(`a same-document ${change} change across a frame's DOM bracket rejects the old image`, async () => {
    const f = await rendererFixture();
    let state = visibleRenderer();
    let release;
    let block = false;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    f.contents.executeJavaScript = async () => {
      if (block) await blocked;
      return structuredClone(state);
    };
    let accepted;
    const pending = f.exports.captureRenderedApp(f.window, Date.now() + 1000);
    void pending.then((value) => {
      accepted = value;
    });
    await f.flush();
    block = true;
    f.present(presentedImage({ painted: true }));
    if (change === "layout") state.controls[0].textRects[0].x++;
    else if (change === "dpr") state.dpr = 2;
    else if (change === "viewport")
      state.viewport = { width: 100, height: 80, scale: 2, x: 0, y: 0 };
    else if (change === "text-style")
      state.controls[0].style = { font: "13px system-ui" };
    else state.shell = { x: 0, y: 0, width: 99, height: 80 };
    release();
    await f.flush();
    assert.equal(
      accepted,
      undefined,
      "stale geometry/style/DPR must not validate the candidate",
    );
    const current = presentedImage({ painted: true });
    f.present(current);
    assert.equal((await pending).image, current);
    assert.equal(f.state.cleanups, 1);
  });
}

test("navigation during the initial DOM baseline fails closed without subscribing or accepting a late query", async () => {
  const f = await rendererFixture();
  let release;
  f.contents.executeJavaScript = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = f.exports.captureRenderedApp(f.window, Date.now() + 1000);
  const rejected = assert.rejects(pending, /navigated/u);
  f.contents.emit("did-start-navigation", { isMainFrame: true });
  await rejected;
  release(visibleRenderer());
  await f.flush();
  assert.equal(f.state.cleanups, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.contents.listenerCount("did-start-navigation"), 0);
  f.present(presentedImage({ painted: true }));
  assert.equal(f.writes.length, 0);
});

for (const isolated of [
  "dark-top-left",
  "bright-top-left",
  "dark-center",
  "bright-bottom-right",
]) {
  test(`R2: a single ${isolated} pixel in each text crop is not rendered text`, async () => {
    const { exports } = await loadObserverFixture();
    const frame = presentedImage();
    const bytes = frame.toBitmap();
    const bright = isolated.startsWith("bright");
    if (bright)
      for (let offset = 0; offset < bytes.length; offset += 4)
        bytes.set([24, 25, 26, 255], offset);
    for (const control of visibleRenderer().controls) {
      const rect = control.textRects[0];
      const x = isolated.endsWith("top-left")
        ? rect.x
        : isolated.endsWith("center")
          ? rect.x + 5
          : rect.x + rect.width - 1;
      const y = isolated.endsWith("top-left")
        ? rect.y
        : isolated.endsWith("center")
          ? rect.y + 7
          : rect.y + rect.height - 1;
      bytes.set(
        bright ? [232, 234, 241, 255] : [24, 25, 26, 255],
        (y * 100 + x) * 4,
      );
    }
    assert.equal(exports.rendererFrameEvidence(frame, visibleRenderer()), null);
  });
}

test("existing real light/dark product-label crops retain sufficient text pixel distribution", async () => {
  const { readFile } = await import("node:fs/promises");
  const { inflateSync } = await import("node:zlib");
  const fixtures = JSON.parse(
    await readFile(
      new URL(
        "./fixtures/startup-acceptance/renderer-label-pixels.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const { exports } = await loadObserverFixture();
  for (const sample of fixtures.cases) {
    const width = Math.max(...sample.controls.map((control) => control.width));
    const height = sample.controls.reduce(
      (total, control) => total + control.height,
      0,
    );
    const bytes = Buffer.alloc(width * height * 4);
    const controls = [];
    let y = 0;
    for (const crop of sample.controls) {
      const pixels = inflateSync(Buffer.from(crop.rgbaDeflateBase64, "base64"));
      assert.equal(pixels.length, crop.width * crop.height * 4);
      for (let row = 0; row < crop.height; row++)
        pixels.copy(
          bytes,
          (y + row) * width * 4,
          row * crop.width * 4,
          (row + 1) * crop.width * 4,
        );
      const rect = { x: 0, y, width: crop.width, height: crop.height };
      controls.push({
        selector: crop.selector,
        textPresent: true,
        ...rect,
        textRects: [rect],
      });
      y += crop.height;
    }
    // NativeImage double with original captured text pixels. This tests only
    // the bitmap statistic, not live DOM or a native presentation sequence.
    const frame = {
      isEmpty: () => false,
      getSize: () => ({ width, height }),
      toBitmap: () => bytes,
    };
    const evidence = exports.rendererFrameEvidence(frame, {
      ready: true,
      width,
      height,
      dpr: 1,
      controls,
    });
    assert(evidence, sample.name);
    for (const control of evidence.controls)
      assert(control.contrastingPixels >= 8, sample.name);
  }
});

test("one isolated dark or bright point fails at every text-crop location", async () => {
  const { exports } = await loadObserverFixture();
  const observation = visibleRenderer();
  for (const bright of [false, true]) {
    const frame = presentedImage();
    const bytes = frame.toBitmap();
    const background = bright ? [24, 25, 26, 255] : [232, 234, 241, 255];
    const foreground = bright ? [232, 234, 241, 255] : [24, 25, 26, 255];
    for (let offset = 0; offset < bytes.length; offset += 4)
      bytes.set(background, offset);
    for (let row = 0; row < 15; row++)
      for (let column = 0; column < 12; column++) {
        const offsets = observation.controls.map(
          (control) =>
            ((control.textRects[0].y + row) * 100 +
              control.textRects[0].x +
              column) *
            4,
        );
        for (const offset of offsets) bytes.set(foreground, offset);
        assert.equal(
          exports.rendererFrameEvidence(frame, observation),
          null,
          `bright=${bright}, x=${column}, y=${row}`,
        );
        for (const offset of offsets) bytes.set(background, offset);
      }
  }
});
