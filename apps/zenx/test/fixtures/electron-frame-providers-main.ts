/** Native acceptance only. Never launch on a personal/local browser profile. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import {
  app,
  BrowserWindow,
  screen,
  webContents,
  type WebContents,
  type WebFrameMain,
} from "electron";
import {
  ElectronBrowserBackend,
  type ZenXBrowserBackend,
  type BrowserInspection,
} from "../../src/main/capabilities/browser-provider.js";
import { BrowserFrameInputObserver } from "../../src/main/capabilities/browser-frame-input.js";
import { observeFramePreparation } from "../../scripts/browser-frame-capture-diagnostics.mjs";
import { BrowserInputOutcomeUnknownError } from "../../src/main/capabilities/browser-targeted-input.js";
import { createElectronWorkspaceBrowser } from "../../src/main/workspace-browser-electron.js";
import {
  remoteFrameContractPage,
  remoteFrameFixtureFromUrl,
} from "../../src/main/browser-remote-frame-smoke-fixture.js";
import {
  assertNativeFramePlacement,
  assertNativeInputRoute,
  nativeFrameCommandReceipt,
  type NativeInputAttempt,
  type NativeChildRoute,
  type NativeFrameIdentity,
} from "./electron-frame-provider-evidence.js";

type Mode = "nested-same-process" | "nested-oopif";
interface State {
  documentId: string;
  events: { type: string; trusted: boolean; target: string }[];
  values: Record<string, string>;
  clicks: number;
  visibility: string;
  childVisibility: string;
  outer: string;
  inner: string;
}
interface Point {
  x: number;
  y: number;
  documentId: string;
  hitId: string;
  localPoint: { x: number; y: number };
  owners: { id: string; hitId: string; scrollX: number; scrollY: number }[];
}

async function waitFor<T>(
  read: () => Promise<T | undefined>,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 8_000;
  do {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}

function recordTransport(web: WebContents) {
  const inputs: NativeInputAttempt[] = [];
  const routes: NativeChildRoute[] = [];
  const failures: Record<string, unknown>[] = [];
  const commands: Record<string, unknown>[] = [];
  const contexts: Record<string, unknown>[] = [];
  let sequence = 0;
  const original = web.debugger.sendCommand;
  const listener = (
    _event: Electron.Event,
    method: string,
    params: Record<string, any>,
    sessionId?: string,
  ) => {
    if (
      method === "Target.attachedToTarget" &&
      params.targetInfo?.type === "iframe"
    )
      routes.push({
        sessionId: params.sessionId,
        parentSessionId: sessionId ?? "",
        targetId: params.targetInfo.targetId,
        url: params.targetInfo.url,
      });
    if (method === "Runtime.executionContextCreated" && contexts.length < 24) {
      const context = params.context;
      contexts.push({
        sessionId: sessionId ?? "",
        id: context?.id,
        uniqueId: context?.uniqueId,
        name: String(context?.name ?? "").slice(0, 128),
        frameId: context?.auxData?.frameId,
        isDefault: context?.auxData?.isDefault,
      });
    }
  };
  web.debugger.on("message", listener);
  web.debugger.sendCommand = function (method, params, sessionId) {
    const requestSequence = ++sequence;
    if (method.startsWith("Input."))
      inputs.push({
        method,
        type: params?.type,
        sessionId: sessionId ?? "",
        ...(params?.x === undefined ? {} : { x: params.x, y: params.y }),
      });
    // Passive observers never replace the original native promise, add commands,
    // inject events, retry input or change the native failure.
    const pending = original.call(this, method, params, sessionId);
    const failed = (error: unknown, detail?: Record<string, unknown>) => {
      try {
        const receipt = {
          method,
          sessionId: sessionId ?? "",
          error: String(error).slice(0, 2048),
          ...detail,
        };
        if (
          failures.length < 16 &&
          !failures.some(
            (entry) => JSON.stringify(entry) === JSON.stringify(receipt),
          )
        )
          failures.push(receipt);
      } catch {
        /* Diagnostic-only. */
      }
    };
    void pending.then((result) => {
      try {
        const detail = nativeFrameCommandReceipt(method, params ?? {}, result);
        if (detail) {
          commands.push({
            sequence: requestSequence,
            sessionId: sessionId ?? "",
            ...detail,
          });
          if (commands.length > 24) commands.shift();
        }
        if (result?.exceptionDetails)
          failed(result.exceptionDetails.text, detail);
      } catch {
        /* Diagnostic-only. */
      }
    }, failed);
    return pending;
  };
  return {
    inputs,
    routes,
    failures,
    commands,
    contexts,
    restore() {
      web.debugger.sendCommand = original;
      web.debugger.removeListener("message", listener);
    },
  };
}

function identities(root: WebFrameMain): NativeFrameIdentity[] {
  assert.equal(root.frames.length, 1);
  const child = root.frames[0]!;
  assert.equal(child.frames.length, 1);
  const leaf = child.frames[0]!;
  assert.equal(leaf.frames.length, 0);
  return [root, child, leaf].map(
    ({ url, processId, osProcessId, routingId }) => ({
      url,
      processId,
      osProcessId,
      routingId,
    }),
  );
}

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Disposable hosted CI only");
  assert.equal(process.platform, "darwin", "Existing native macOS runner");
  assert.ok(process.versions.electron, "Actual Electron required");
  assert.ok(process.argv[2] && process.argv[3]);
  const evidence = path.resolve(process.argv[2]!);
  const privateDirectory = path.resolve(process.argv[3]!);
  app.setPath("userData", path.join(privateDirectory, "profile"));
  // Disposable fixture flags only. Keep production launch behavior unchanged;
  // native process identities below still have to prove actual placement.
  app.commandLine.appendSwitch("site-per-process");
  app.commandLine.appendSwitch(
    "host-resolver-rules",
    "MAP localhost 127.0.0.1, MAP nested.localhost 127.0.0.1",
  );
  app.on("window-all-closed", () => undefined);
  const cases: Record<string, unknown>[] = [];
  let phase = "startup";
  let failure: unknown;
  const cleanupFailures: string[] = [];
  const serve = (
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.setHeader("Origin-Agent-Cluster", "?0");
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      assert.ok(
        ["/input-contract", "/remote-frame-child"].includes(url.pathname),
      );
      response.end(
        remoteFrameContractPage(
          url.pathname === "/input-contract" ? "parent" : "child",
          remoteFrameFixtureFromUrl(request.url!),
        ),
      );
    } catch {
      response.writeHead(404);
      response.end();
    }
  };
  const servers = [createServer(serve), createServer(serve)];
  let sentinel: BrowserWindow | undefined;
  try {
    for (const server of servers) {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
    }
    const ports = servers.map((server) => {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      return address.port;
    });
    await app.whenReady();
    sentinel = new BrowserWindow({
      show: false,
      width: 400,
      height: 300,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await sentinel.loadURL(
      "data:text/html," +
        encodeURIComponent(
          `<!doctype html><input id="sentinel" value="unchanged" autofocus><script>window.events=[];for(const type of ['pointerdown','pointerup','keydown','keyup','input','focus','blur','visibilitychange'])window.addEventListener(type,event=>events.push({type,trusted:event.isTrusted}),true);window.state=()=>({value:document.querySelector('input').value,events:[...events],focus:document.activeElement.id})</script>`,
        ),
    );
    const nativeSentinelEvents: string[] = [];
    sentinel.on("focus", () => nativeSentinelEvents.push("focus"));
    sentinel.on("blur", () => nativeSentinelEvents.push("blur"));
    sentinel.on("hide", () => nativeSentinelEvents.push("hide"));
    sentinel.on("minimize", () => nativeSentinelEvents.push("minimize"));
    sentinel.show();
    await waitFor(
      async () =>
        BrowserWindow.getFocusedWindow() === sentinel ? true : undefined,
      "owned sentinel focus during setup",
    );
    const initialSentinel = await waitFor(async () => {
      const state =
        await sentinel!.webContents.executeJavaScript("window.state()");
      return state.focus === "sentinel" ? state : undefined;
    }, "sentinel input focus during setup");
    const nativeSentinelBaseline = [...nativeSentinelEvents];
    const cursor = screen.getCursorScreenPoint();
    const guard = async () => {
      assert.deepEqual(
        nativeSentinelEvents,
        nativeSentinelBaseline,
        "No transient native sentinel focus/visibility loss",
      );
      assert.ok(
        BrowserWindow.getFocusedWindow() === sentinel,
        "Provider must preserve the owned Electron sentinel focus",
      );
      assert.deepEqual(
        screen.getCursorScreenPoint(),
        cursor,
        "Provider must not move the physical cursor",
      );
      assert.deepEqual(
        await sentinel!.webContents.executeJavaScript("window.state()"),
        initialSentinel,
        "Sentinel value, focus and trusted event history must remain unchanged",
      );
    };
    for (const provider of ["workspace-browser", "electron-browser"] as const) {
      const sessionId = `frame-${provider}`;
      const workspace =
        provider === "workspace-browser"
          ? createElectronWorkspaceBrowser({
              artifactDirectory: path.join(
                privateDirectory,
                `${provider}-artifacts`,
              ),
            })
          : undefined;
      workspace?.bindThreadSession(sessionId, "native-frame-fixture-thread");
      const backend: ZenXBrowserBackend =
        workspace ??
        new ElectronBrowserBackend({
          artifactDirectory: path.join(
            privateDirectory,
            `${provider}-artifacts`,
          ),
        });
      assert.ok(backend.pointerClick && backend.keyPress);
      let providerFailure: unknown;
      try {
        for (const mode of ["nested-same-process", "nested-oopif"] as const) {
          phase = `${provider}/${mode}/open`;
          const url = new URL(
            `/input-contract`,
            `http://127.0.0.1:${ports[0]}`,
          );
          const config = {
            mode,
            parentOrigin: url.origin,
            childOrigin: `http://localhost:${ports[1]}`,
            nonce: randomUUID(),
            outerAffine: "true" as const,
            leafOrigin: `http://${mode === "nested-oopif" ? "nested.localhost" : "localhost"}:${ports[0]}`,
          };
          for (const [key, value] of Object.entries(config))
            url.searchParams.set(key, value);
          const owned = await backend.open(sessionId, url.href);
          const matches = webContents
            .getAllWebContents()
            .filter((web) => web.getURL() === url.href);
          assert.equal(
            matches.length,
            1,
            "Find only the exact nonce-bound provider-created root",
          );
          const web = matches[0]!;
          const transport = recordTransport(web);
          const preparation = observeFramePreparation(
            BrowserFrameInputObserver.prototype,
          );
          const receipt: Record<string, unknown> = {
            provider,
            mode,
            ownedTabId: owned.tabId,
            webContentsId: web.id,
            transport: "Electron webContents.debugger.sendCommand",
            presentation: workspace
              ? "unmounted WebContentsView with production render lease"
              : "hidden production BrowserWindow",
            status: "incomplete",
            inputs: transport.inputs,
            routes: transport.routes,
            nativeFailures: transport.failures,
            nativeCommands: transport.commands,
            nativeContexts: transport.contexts,
            framePreparation: preparation.receipt,
          };
          cases.push(receipt);
          const evaluate = async <T>(expression: string): Promise<T> =>
            (await web.executeJavaScript(expression)) as T;
          const state = async () =>
            await evaluate<State>("window.contract.state()");
          const inspect = async (): Promise<BrowserInspection> =>
            await waitFor(async () => {
              const start = transport.inputs.length;
              const observed = await backend.inspect(sessionId, owned.tabId);
              assert.equal(observed.screenshot.status, "captured");
              assert.equal(
                transport.inputs.length,
                start,
                "Inspection is read-only",
              );
              await guard();
              return observed.inputViewport ? observed : undefined;
            }, `${phase}: coherent provider screenshot (read-only)`);
          try {
            await waitFor(
              async () =>
                (await evaluate<boolean>("window.contract?.ready === true"))
                  ? true
                  : undefined,
              `${phase}: fixture ready`,
            );
            const frames = identities(web.mainFrame);
            const outerUrl = new URL("/remote-frame-child", config.childOrigin);
            for (const [key, value] of Object.entries(config))
              outerUrl.searchParams.set(key, value);
            const leafUrl = new URL("/remote-frame-child", config.leafOrigin);
            for (const [key, value] of Object.entries({
              ...config,
              parentOrigin: config.childOrigin,
              childOrigin: config.leafOrigin,
              leafOrigin: "",
            }))
              leafUrl.searchParams.set(key, value);
            const urls = [url.href, outerUrl.href, leafUrl.href];
            assertNativeFramePlacement(frames, mode, urls);
            receipt.frames = frames;
            await inspect(); // Initial native observer discovery, no input or repair.
            const point = await evaluate<Point>(
              "window.contract.point('canvas')",
            );
            assert.equal(point.hitId, "canvas");
            assert.deepEqual(point.localPoint, { x: 100, y: 30 });
            assert.deepEqual(
              point.owners.map(({ id, hitId, scrollX, scrollY }) => ({
                id,
                hitId,
                scrollX,
                scrollY,
              })),
              ["contract-frame", "nested-contract-frame"].map((id) => ({
                id,
                hitId: id,
                scrollX: 0,
                scrollY: 0,
              })),
            );
            const cosine = Math.cos(Math.PI / 12),
              sine = Math.sin(Math.PI / 12);
            assert.ok(
              Math.abs(
                point.x -
                  (422 + cosine * (145 + 12 - 322) - sine * (85 + 16 - 256)),
              ) < 0.01,
            );
            assert.ok(
              Math.abs(
                point.y -
                  (346 + sine * (145 + 12 - 322) + cosine * (85 + 16 - 256)),
              ) < 0.01,
            );
            receipt.point = point;
            for (const kind of ["click", "key"] as const) {
              phase = `${provider}/${mode}/${kind}`;
              if (kind === "key")
                await evaluate("window.contract.focus('text-a')");
              const observed = await inspect();
              const before = await state();
              assert.equal(before.visibility, "hidden");
              assert.equal(before.childVisibility, "hidden");
              await guard();
              const start = transport.inputs.length;
              if (kind === "click")
                await backend.pointerClick!(
                  sessionId,
                  owned.tabId,
                  observed.observationId,
                  point.x,
                  point.y,
                );
              else
                await backend.keyPress!(
                  sessionId,
                  owned.tabId,
                  observed.observationId,
                  "Space",
                );
              assertNativeInputRoute(
                transport.inputs.slice(start),
                transport.routes,
                mode,
                urls,
                kind,
              );
              const expected = (
                kind === "click"
                  ? ["pointerdown", "pointerup"]
                  : ["keydown", "keyup"]
              ).map((type) => ({
                type,
                trusted: true,
                target: kind === "click" ? "canvas" : "text-a",
              }));
              const after = await waitFor(async () => {
                const current = await state();
                await guard();
                assert.equal(current.visibility, "hidden");
                assert.equal(current.childVisibility, "hidden");
                assert.equal(current.documentId, before.documentId);
                assert.deepEqual(
                  current.events.slice(0, before.events.length),
                  before.events,
                );
                const events = current.events.slice(before.events.length);
                assert.ok(events.length <= expected.length);
                assert.deepEqual(events, expected.slice(0, events.length));
                const clicks = before.clicks + Number(kind === "click");
                const value =
                  before.values["text-a"] + (kind === "key" ? " " : "");
                return events.length === expected.length &&
                  current.clicks === clicks &&
                  current.values["text-a"] === value
                  ? current
                  : undefined;
              }, `${phase}: trusted pair and application effect, no replay`);
              await guard();
              receipt[kind] = {
                trustedEvents: after.events.slice(before.events.length),
                clicks: after.clicks,
                textValue: after.values["text-a"],
              };
            }
            if (mode === "nested-same-process") {
              phase = `${provider}/${mode}/stale-inner-focus`;
              await evaluate("window.contract.focus('text-a')");
              const observed = await inspect();
              const before = await state();
              await evaluate("window.contract.focus('text-b')");
              const changed = await state();
              assert.equal(before.outer, changed.outer);
              assert.equal(changed.inner, "text-b");
              const count = transport.inputs.length;
              await guard();
              await assert.rejects(
                backend.keyPress!(
                  sessionId,
                  owned.tabId,
                  observed.observationId,
                  "Space",
                ),
                /changed|stale|inspect again/iu,
              );
              assert.equal(transport.inputs.length, count);
              assert.deepEqual((await state()).events, before.events);
              await guard();
              receipt.staleFocus = { rejected: true, inputDispatches: 0 };
            } else {
              phase = `${provider}/${mode}/interrupted-press`;
              await evaluate("window.contract.armReplace()");
              const observed = await inspect();
              const before = await state();
              const start = transport.inputs.length;
              await guard();
              await assert.rejects(
                backend.pointerClick!(
                  sessionId,
                  owned.tabId,
                  observed.observationId,
                  point.x,
                  point.y,
                ),
                (error) => {
                  assert.ok(error instanceof BrowserInputOutcomeUnknownError);
                  assert.equal(error.inputMayRemainPressed, true);
                  return true;
                },
              );
              assert.deepEqual(
                transport.inputs
                  .slice(start)
                  .map(({ method, type }) => ({ method, type })),
                [{ method: "Input.dispatchMouseEvent", type: "mousePressed" }],
              );
              const after = await state();
              assert.equal(after.visibility, "hidden");
              assert.equal(after.childVisibility, "hidden");
              assert.notEqual(after.documentId, before.documentId);
              assert.deepEqual(after.events.slice(before.events.length), [
                { type: "pointerdown", trusted: true, target: "canvas" },
              ]);
              assert.equal(after.clicks, before.clicks);
              const fresh = await backend.inspect(sessionId, owned.tabId);
              assert.equal(fresh.screenshot.status, "captured");
              assert.equal(fresh.inputViewport, undefined);
              // Explicitly different operations prove the tab quarantine, never
              // replay or release the earlier unknown mouse press.
              await guard();
              await assert.rejects(
                backend.keyPress!(
                  sessionId,
                  owned.tabId,
                  fresh.observationId,
                  "Space",
                ),
                /blocked|held|pressed|close.*tab/iu,
              );
              await guard();
              await assert.rejects(
                backend.pointerClick!(
                  sessionId,
                  owned.tabId,
                  fresh.observationId,
                  1,
                  1,
                ),
                /blocked|held|pressed|close.*tab/iu,
              );
              assert.equal(transport.inputs.length, start + 1);
              assert.deepEqual((await state()).events, after.events);
              await guard();
              receipt.quarantine = {
                inputDispatches: 1,
                successorReleaseDispatches: 0,
                laterInputDispatches: 0,
                trustedPress: true,
              };
            }
            receipt.status = "passed";
          } catch (error) {
            receipt.failure = String(error);
            throw error;
          } finally {
            // Both local providers own actual native pages. Their close must
            // destroy this exact WebContents, including a possibly held press.
            preparation.restore();
            transport.restore();
            try {
              await backend.closeTab(sessionId, owned.tabId);
              await waitFor(
                async () => (web.isDestroyed() ? true : undefined),
                `${provider}: exact native target destroyed`,
              );
              receipt.physicallyClosed = true;
              await guard();
            } catch (error) {
              receipt.cleanupError = String(error);
              cleanupFailures.push(`${provider}/${mode}: ${String(error)}`);
              // Teardown only, never input or a success substitute. This exact
              // positively-created synthetic page must not retain held input.
              try {
                if (!web.isDestroyed()) web.close();
              } catch (cleanup) {
                cleanupFailures.push(String(cleanup));
              }
              if (receipt.failure === undefined) throw error;
            }
          }
        }
      } catch (error) {
        providerFailure = error;
        throw error;
      } finally {
        try {
          if (workspace) await workspace.shutdown();
          else await backend.close();
        } catch (error) {
          cleanupFailures.push(`${provider} shutdown: ${String(error)}`);
          if (providerFailure === undefined) throw error;
        }
      }
    }
  } catch (error) {
    failure = error;
    process.exitCode = 1;
    console.error("Electron frame provider smoke failed", phase, error);
  } finally {
    try {
      if (sentinel && !sentinel.isDestroyed()) sentinel.destroy();
    } catch (error) {
      cleanupFailures.push(`sentinel close: ${String(error)}`);
    }
    for (const server of servers) {
      try {
        server.closeAllConnections();
        if (server.listening)
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
      } catch (error) {
        cleanupFailures.push(`server close: ${String(error)}`);
      }
    }
    if (cleanupFailures.length) {
      failure ??= new Error("Native fixture cleanup failed");
      process.exitCode = 1;
    }
    if (failure !== undefined) {
      const diagnostic = JSON.stringify({
        phase,
        error: String(failure),
        cleanupFailures,
        case: cases.at(-1),
      });
      console.error(
        "ZENX_NATIVE_FRAME_FAILURE",
        diagnostic.slice(0, 32768),
        diagnostic.length > 32768 ? "[truncated]" : "",
      );
    }
    await writeFile(
      path.join(evidence, "result.json"),
      JSON.stringify(
        {
          ok: failure === undefined,
          phase,
          error: failure === undefined ? undefined : String(failure),
          source: JSON.parse(
            await readFile(path.join(evidence, "source.json"), "utf8"),
          ),
          platform: process.platform,
          electron: process.versions.electron,
          chrome: process.versions.chrome,
          foregroundEvidence:
            "Electron sentinel focus/value/trusted event history and physical cursor only; independent OS foreground application sampling not exercised",
          nativeExtensionRouting: "not exercised",
          fixtureFlags: [
            "site-per-process",
            "host-resolver-rules=MAP localhost 127.0.0.1, MAP nested.localhost 127.0.0.1",
          ],
          defaultProcessAllocation:
            "not exercised; fixture explicitly enables site isolation",
          cleanupFailures,
          cases,
        },
        null,
        2,
      ) + "\n",
    );
    app.quit();
  }
}
void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
