import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { ipcChannels } from "../src/preload/ipc.js";

const require = createRequire(import.meta.url);
const preload = await build({
  entryPoints: [
    fileURLToPath(new URL("../src/preload/index.ts", import.meta.url)),
  ],
  bundle: true,
  format: "cjs",
  platform: "node",
  packages: "external",
  write: false,
});

function loadPreload(document?: Document, platform = "linux") {
  const sent: unknown[][] = [];
  const ipc = Object.assign(new EventEmitter(), {
    send: (...args: unknown[]) => sent.push(args),
  });
  let exposed!: Window["zenx"];
  const electron = {
    ipcRenderer: ipc,
    contextBridge: {
      exposeInMainWorld(name: string, api: Window["zenx"]) {
        assert.equal(name, "zenx");
        exposed = api;
      },
    },
  };
  const context = {
    ...(document ? { document } : {}),
    process: { platform },
    crypto: { randomUUID: () => "document-registration" },
    setTimeout,
    clearTimeout,
    require: (name: string) => (name === "electron" ? electron : require(name)),
  };
  runInNewContext(preload.outputFiles![0]!.text, context);
  const nativeEditing = exposed.nativeEditing;
  assert.ok(nativeEditing);
  return { exposed, nativeEditing, context, ipc, sent };
}

test("actual preload exposes its bridge without a document or eager IPC side effects", () => {
  const f = loadPreload();
  assert.equal("document" in f.context, false);
  assert.equal(typeof f.exposed.settings.openDiagnosticsFolder, "function");
  assert.equal(typeof f.nativeEditing.onPrepareSelectAll, "function");
  assert.deepEqual(f.sent, []);
  assert.equal(f.ipc.eventNames().length, 0);
});

for (const platform of ["darwin", "win32", "linux"])
  test(`${platform} actual preload captures its original document and retains native key/menu semantics`, () => {
    const dom = new JSDOM('<body tabindex="0"><input></body>');
    const replacement = new JSDOM('<body tabindex="0"></body>');
    const f = loadPreload(dom.window.document, platform);
    // Subscription must not retarget the bridge after preload initialization.
    f.context.document = replacement.window.document;
    let prepared = 0;
    let cancelled = 0;
    const offCancel = f.nativeEditing.onSelectAllCancelled(() => cancelled++);
    const off = f.nativeEditing.onPrepareSelectAll(() => {
      prepared++;
      return true;
    });
    const key = (target: JSDOM) =>
      new target.window.KeyboardEvent("keydown", {
        key: "a",
        ctrlKey: platform !== "darwin",
        metaKey: platform === "darwin",
        bubbles: true,
        cancelable: true,
      });
    try {
      replacement.window.document.body.dispatchEvent(key(replacement));
      assert.equal(prepared, 0);
      const input = dom.window.document.querySelector("input")!;
      input.focus();
      const editorKey = key(dom);
      input.dispatchEvent(editorKey);
      assert.equal(prepared, 0);
      assert.equal(editorKey.defaultPrevented, false);
      dom.window.document.body.focus();
      const bodyKey = key(dom);
      dom.window.document.body.dispatchEvent(bodyKey);
      assert.equal(prepared, 1);
      assert.equal(bodyKey.defaultPrevented, false);

      f.ipc.emit(ipcChannels.nativeEditingPrepare, {}, "stale-token", 1);
      assert.equal(prepared, 1);
      f.ipc.emit(
        ipcChannels.nativeEditingPrepare,
        {},
        "document-registration",
        2,
      );
      assert.equal(prepared, 2);
      assert.deepEqual(f.sent.at(-1), [
        ipcChannels.nativeEditingPrepared,
        "document-registration",
        2,
        true,
      ]);
      f.ipc.emit(
        ipcChannels.nativeEditingCompleted,
        {},
        "document-registration",
        2,
        false,
      );
      assert.equal(cancelled, 2);
    } finally {
      off();
      offCancel();
      dom.window.document.body.dispatchEvent(key(dom));
      assert.equal(
        prepared,
        2,
        "unsubscribe removes the captured key listener",
      );
      assert.equal(f.ipc.eventNames().length, 0);
      dom.window.close();
      replacement.window.close();
    }
  });
