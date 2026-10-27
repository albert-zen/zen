import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, type WebFrameMain } from "electron";
import { FileTraceStore } from "../../../../src/trace.js";
import { ModelRequestDebugStore } from "../../../cli/src/model-request-debug.js";
import type { ModelRequestDebugCommand } from "../../../cli/src/model-request-debug-types.js";
import { installModelRequestDebugIpc } from "../../src/main/model-request-debug-electron.js";
import { ipcChannels } from "../../src/preload/ipc.js";

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Disposable cloud CI only");
  assert.equal(process.platform, "darwin", "Existing native macOS CI runner");
  assert(process.versions.electron, "Actual Electron required");
  const directory = path.resolve(process.argv[2]!);
  const privateDirectory = path.resolve(process.argv[3]!);
  assert(
    process.argv[2] && process.argv[3],
    "Evidence and private directories required",
  );
  await mkdir(path.join(privateDirectory, "profile"), { recursive: true });
  app.setPath("userData", path.join(privateDirectory, "profile"));
  app.on("window-all-closed", () => undefined);
  const windows: BrowserWindow[] = [];
  const ownedWindowIds = new Set<number>();
  const cases: Array<{
    name: string;
    view: string;
    allowed: boolean;
    readerCalls: number;
  }> = [];
  const source = JSON.parse(
    await readFile(path.join(directory, "source.json"), "utf8"),
  );
  let readerCalls = 0;
  let result: { ok: boolean; error?: string } = { ok: false };
  try {
    await mkdir(privateDirectory, { recursive: true });
    const renderer = path.join(privateDirectory, "renderer.html");
    const foreign = path.join(privateDirectory, "foreign.html");
    await writeFile(
      renderer,
      "<!doctype html><title>Synthetic trusted Trace renderer</title>",
    );
    await writeFile(
      foreign,
      "<!doctype html><title>Synthetic foreign Trace renderer</title>",
    );
    const rendererUrl = pathToFileURL(renderer).href;
    const foreignUrl = pathToFileURL(foreign).href;
    const trace = new FileTraceStore(path.join(privateDirectory, "trace"));
    const bytes =
      '\uFEFF{"messages":[{"role":"user","content":"SYNTHETIC_TRACE_GATE_SENTINEL_秘密😀"}]}';
    const receipt = await trace.record({
      threadId: "native-trace-fixture",
      sampleId: "sample-fixture",
      type: "model_request",
      data: { transportAttempt: 1, format: "responses" },
      artifacts: [
        { name: "request_body", bytes, mediaType: "application/json" },
      ],
    });
    assert.equal(receipt.durability, "durable");
    assert(receipt.durability === "durable");
    await trace.flush();
    // A new reader opens committed evidence; no in-memory fake response API.
    const reader = new ModelRequestDebugStore(
      new FileTraceStore(path.join(privateDirectory, "trace")),
    );
    installModelRequestDebugIpc({
      rendererUrl,
      ownedWindowIds,
      async read(command) {
        readerCalls++;
        return reader.control(command);
      },
    });
    await app.whenReady();
    const createWindow = (owned: boolean) => {
      const window = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: path.join(directory, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          // Fixture only: give sibling frames the IPC bridge so denial is
          // proved at the actual native gate, not just by missing JS access.
          nodeIntegrationInSubFrames: true,
        },
      });
      windows.push(window);
      if (owned) ownedWindowIds.add(window.id);
      window.once("closed", () => ownedWindowIds.delete(window.id));
      return window;
    };
    const invoke = async (
      frame: WebFrameMain,
      command: ModelRequestDebugCommand,
    ): Promise<unknown> =>
      frame.executeJavaScript(`(async () => {
        if (!window.traceGateFixture) throw new Error('Native fixture preload missing');
        try { return {ok:true, value:await window.traceGateFixture.invoke(${JSON.stringify(command)})}; }
        catch (error) { return {ok:false,error:String(error.message || error)}; }
      })()`);
    const verify = async (
      name: string,
      frame: WebFrameMain,
      allowed: boolean,
    ) => {
      for (const view of ["payload", "artifact"] as const) {
        const before = readerCalls;
        const reply = await invoke(frame, {
          action: "read",
          threadId: "native-trace-fixture",
          id: receipt.recordId,
          view,
        });
        assert(reply !== null && typeof reply === "object" && "ok" in reply);
        assert.equal(
          reply.ok,
          allowed,
          `${name}/${view}: ${JSON.stringify(reply)}`,
        );
        if (allowed) {
          assert(reply.ok && "value" in reply);
          const value = reply.value;
          assert(
            value !== null && typeof value === "object" && "page" in value,
          );
          const page = value.page;
          assert(
            page !== null &&
              typeof page === "object" &&
              "availability" in page &&
              "text" in page,
          );
          assert.equal(page.availability, "available");
          assert.equal(page.text, bytes);
          assert.equal(readerCalls, before + 1);
        } else {
          assert(
            !reply.ok && "error" in reply && typeof reply.error === "string",
          );
          assert.match(
            reply.error,
            /Trace reading requires the trusted ZenX main frame/u,
          );
          assert(
            !JSON.stringify(reply).includes("SYNTHETIC_TRACE_GATE_SENTINEL"),
          );
          assert.equal(
            readerCalls,
            before,
            "Denied native sender must not reach the reader",
          );
        }
        cases.push({ name, view, allowed, readerCalls });
      }
    };
    const owned = createWindow(true);
    await owned.loadURL(`${rendererUrl}#trace`);
    await verify("owned-main-frame", owned.webContents.mainFrame, true);
    for (const [name, url] of [
      ["same-document-sibling", `${rendererUrl}#sibling`],
      ["foreign-document-sibling", foreignUrl],
    ] as const) {
      await owned.webContents
        .executeJavaScript(`new Promise((resolve, reject) => {
        const frame = document.createElement('iframe');
        frame.onload = () => resolve(true); frame.onerror = () => reject(new Error('Synthetic frame load failed'));
        frame.src = ${JSON.stringify(url)}; document.body.append(frame);
      })`);
      const frame = owned.webContents.mainFrame.frames.find(
        (entry) => entry.url === url,
      );
      assert(frame, `Actual child frame loaded: ${name}`);
      assert.notEqual(frame, owned.webContents.mainFrame);
      await verify(name, frame, false);
    }
    const unowned = createWindow(false);
    await unowned.loadURL(rendererUrl);
    await verify(
      "unowned-same-document-main-frame",
      unowned.webContents.mainFrame,
      false,
    );
    await owned.loadURL(foreignUrl);
    await verify(
      "owned-foreign-document-main-frame",
      owned.webContents.mainFrame,
      false,
    );
    await owned.loadURL(rendererUrl);
    await verify(
      "owned-main-frame-after-navigation",
      owned.webContents.mainFrame,
      true,
    );
    assert.equal(readerCalls, 4);
    assert.equal(cases.length, 12);
    result = { ok: true };
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      (await trace.read("native-trace-fixture")).records[0]?.artifacts[0]?.ref
        .sha256,
    );
  } catch (error) {
    result = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    throw error;
  } finally {
    ipcMain.removeHandler(ipcChannels.modelRequestDebug);
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    await writeFile(
      path.join(directory, "result.json"),
      JSON.stringify(
        {
          ...result,
          source,
          scope:
            "Real Electron frame identities, production Trace IPC installer and disk reader; synthetic profile and bytes only. No user Host or provider request.",
          platform: process.platform,
          electron: process.versions.electron,
          readerCalls,
          cases,
        },
        null,
        2,
      ) + "\n",
    );
  }
}

void main().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
