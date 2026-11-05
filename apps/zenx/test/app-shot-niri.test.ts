/**
 * Synthetic Unix-socket regression tests adapted from T3 Code NiriSnapShot.test.ts
 * at 337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17 (MIT, T3 Tools Inc. 2026).
 * The full upstream permission notice is in ../src/main/app-shot-niri.ts.
 * These tests do not validate a real compositor, native PNG decoder or grants.
 */
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  captureNiriActiveAppShot,
  checkNiriCaptureSupport,
  isNiriSession,
  niriSocketPath,
  type NiriAppShotImage,
  type NiriAppShotOptions,
} from "../src/main/app-shot-niri.js";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const originalWindow = {
  id: 42,
  title: "Editor",
  app_id: "org.example.Editor",
  pid: process.pid + 1_000,
  layout: { window_size: [800, 600] },
};
type TestWindow = {
  id: number;
  title: string | null;
  app_id: string | null;
  pid: number | null;
  layout: { window_size: number[] };
};
type Screenshot = {
  id: number;
  path: string;
  write_to_disk: boolean;
  show_pointer: boolean;
};
type Request = string | { Action: { ScreenshotWindow?: Screenshot } };

function send(socket: NodeNet.Socket, value: unknown): void {
  socket.write(JSON.stringify(value) + "\n");
}

function fakeImage(width = 800, height = 600, bytes = png): NiriAppShotImage {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    resize: (size) => fakeImage(size.width, size.height, bytes),
    toPNG: () => bytes,
  };
}

it("recognizes the actual Niri session, not stale or sandboxed sockets", () => {
  const path = NodePath.resolve(NodeOS.tmpdir(), "niri.sock");
  const env = { XDG_CURRENT_DESKTOP: "niri", NIRI_SOCKET: path };
  assert.equal(isNiriSession(env), true);
  assert.equal(niriSocketPath(env), path);
  assert.equal(
    niriSocketPath({ ...env, XDG_CURRENT_DESKTOP: "NIRI:other" }),
    path,
  );
  for (const changed of [
    { XDG_CURRENT_DESKTOP: "GNOME" },
    { XDG_CURRENT_DESKTOP: "not-niri" },
    { NIRI_SOCKET: "relative" },
    { NIRI_SOCKET: "" },
    { FLATPAK_ID: "app" },
    { SNAP: "/snap/app" },
  ]) {
    assert.equal(niriSocketPath({ ...env, ...changed }), undefined);
  }
});

it("rejects unavailable sessions without fallback", async () => {
  await assert.rejects(
    captureNiriActiveAppShot({ env: {} }),
    /unavailable in this session/,
  );
  await assert.rejects(
    captureNiriActiveAppShot({ socketPath: "relative" }),
    /unavailable in this session/,
  );
});

describe(
  "Niri App Shot synthetic compositor transport",
  { skip: process.platform === "win32" },
  () => {
    let directory: string;
    let socketPath: string;
    let server: NodeNet.Server;
    let sockets: Set<NodeNet.Socket>;
    let events: NodeNet.Socket[];
    let calls: Request[];
    let handler: (request: Request, socket: NodeNet.Socket) => Promise<void>;
    let focused: TestWindow | null;
    let windows: TestWindow[];
    let capturePath: string | undefined;
    let version: string;

    const capture = (options: NiriAppShotOptions = {}) =>
      captureNiriActiveAppShot({
        socketPath,
        createImage: () => fakeImage(),
        ...options,
      });

    beforeEach(async () => {
      directory = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "zen-niri-"),
      );
      socketPath = NodePath.join(directory, "ipc");
      sockets = new Set();
      events = [];
      calls = [];
      focused = structuredClone(originalWindow);
      windows = [structuredClone(originalWindow)];
      capturePath = undefined;
      version = "26.04 (v26.04)";
      handler = async (request, socket) => {
        if (request === "EventStream") {
          events.push(socket);
          send(socket, { Ok: "Handled" });
          send(socket, { WindowsChanged: { windows } });
        } else if (request === "Version") {
          send(socket, { Ok: { Version: version } });
        } else if (request === "FocusedWindow") {
          send(socket, { Ok: { FocusedWindow: focused } });
        } else if (request === "Windows") {
          send(socket, { Ok: { Windows: windows } });
        } else if (
          typeof request !== "string" &&
          request.Action.ScreenshotWindow
        ) {
          const screenshot = request.Action.ScreenshotWindow;
          capturePath = screenshot.path;
          focused = { ...originalWindow, id: 99, title: "Another app" };
          await NodeFSP.writeFile(screenshot.path, png);
          for (const event of events) {
            send(event, { UnrelatedEvent: { anything: true } });
            send(event, { ScreenshotCaptured: { path: null } });
            send(event, { ScreenshotCaptured: { path: "/another-app.png" } });
            // Niri may emit completion before acknowledging the command.
            send(event, { ScreenshotCaptured: { path: screenshot.path } });
          }
          send(socket, { Ok: "Handled" });
        } else {
          send(socket, { Ok: "Handled" });
        }
      };
      server = NodeNet.createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => undefined);
        socket.setEncoding("utf8");
        let pending = "";
        socket.on("data", (chunk: string) => {
          pending += chunk;
          let end: number;
          while ((end = pending.indexOf("\n")) !== -1) {
            const request = JSON.parse(pending.slice(0, end)) as Request;
            pending = pending.slice(end + 1);
            calls.push(request);
            void handler(request, socket).catch((error: unknown) =>
              socket.destroy(error instanceof Error ? error : undefined),
            );
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
    });

    afterEach(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(directory, { recursive: true, force: true });
    });

    async function assertPrivateCaptureRemoved(): Promise<void> {
      assert.ok(capturePath);
      await assert.rejects(NodeFSP.stat(NodePath.dirname(capturePath)), {
        code: "ENOENT",
      });
    }

    it("captures the original window ID and cleans up", async () => {
      const snapshot = await capture();
      assert.deepEqual(snapshot, {
        png,
        width: 800,
        height: 600,
        window: {
          id: 42,
          pid: originalWindow.pid,
          title: "Editor",
          appId: "org.example.Editor",
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          accessibilityBoundsReliable: false,
        },
      });
      assert.deepEqual(calls, [
        "Version",
        "EventStream",
        "FocusedWindow",
        {
          Action: {
            ScreenshotWindow: {
              id: 42,
              path: capturePath,
              write_to_disk: true,
              show_pointer: false,
            },
          },
        },
        "Windows",
      ]);
      await assertPrivateCaptureRemoved();
    });

    it("waits for initial state before capturing", async () => {
      let markSubscribed: (socket: NodeNet.Socket) => void = () => undefined;
      const subscribed = new Promise<NodeNet.Socket>((resolve) => {
        markSubscribed = resolve;
      });
      const original = handler;
      handler = async (request, socket) => {
        if (request === "EventStream") {
          events.push(socket);
          send(socket, { Ok: "Handled" });
          markSubscribed(socket);
        } else {
          await original(request, socket);
        }
      };
      const pending = capture();
      const subscription = await subscribed;
      await nextTurn();
      assert.equal(calls.includes("FocusedWindow"), false);
      send(subscription, { WindowsChanged: { windows } });
      await pending;
      await assertPrivateCaptureRemoved();
    });

    it("accepts completion before the action reply", async () => {
      const original = handler;
      handler = async (request, socket) => {
        if (typeof request !== "string" && request.Action.ScreenshotWindow) {
          capturePath = request.Action.ScreenshotWindow.path;
          await NodeFSP.writeFile(capturePath, png);
          for (const event of events)
            send(event, { ScreenshotCaptured: { path: capturePath } });
          await nextTurn();
          await nextTurn();
          send(socket, { Ok: "Handled" });
        } else {
          await original(request, socket);
        }
      };
      assert.deepEqual((await capture()).png, png);
      await assertPrivateCaptureRemoved();
    });

    const changes: Array<[string, (window: TestWindow) => TestWindow[]]> = [
      ["closed", () => []],
      ["id", (window) => [{ ...window, id: 99 }]],
      ["pid", (window) => [{ ...window, pid: 456 }]],
      ["title", (window) => [{ ...window, title: "Different document" }]],
      ["app ID", (window) => [{ ...window, app_id: "other.application" }]],
      [
        "width",
        (window) => [{ ...window, layout: { window_size: [900, 600] } }],
      ],
      [
        "height",
        (window) => [{ ...window, layout: { window_size: [800, 700] } }],
      ],
    ];
    for (const [name, change] of changes) {
      it("drops changed identity: " + name, async () => {
        windows = change(structuredClone(originalWindow));
        const snapshot = await capture();
        assert.deepEqual(snapshot.png, png);
        assert.equal(snapshot.window, undefined);
        await assertPrivateCaptureRemoved();
      });
    }

    it("does not invent missing PID, title, or app ID", async () => {
      focused = { ...originalWindow, pid: null, title: null, app_id: null };
      windows = [structuredClone(focused)];
      const snapshot = await capture();
      assert.equal(snapshot.window?.pid, null);
      assert.equal(snapshot.window?.title, null);
      assert.equal(snapshot.window?.appId, null);
    });

    it("fails without a focused window", async () => {
      focused = null;
      await assert.rejects(capture(), /no focused window/);
      assert.equal(capturePath, undefined);
      assert.equal(
        calls.some((call) => typeof call !== "string"),
        false,
      );
    });

    it("propagates denial without fallback and cleans up", async () => {
      const original = handler;
      handler = async (request, socket) => {
        if (typeof request !== "string" && request.Action.ScreenshotWindow) {
          capturePath = request.Action.ScreenshotWindow.path;
          send(socket, { Err: "window disappeared" });
        } else {
          await original(request, socket);
        }
      };
      await assert.rejects(capture(), /window disappeared/);
      assert.equal(calls.includes("Windows"), false);
      await assertPrivateCaptureRemoved();
    });

    for (const value of ["24.11", "25.05", "unknown"]) {
      it("rejects unsupported version " + value, async () => {
        version = value;
        await assert.rejects(capture(), /25.11 or newer/);
        assert.deepEqual(calls, ["Version"]);
      });
    }
    for (const value of ["25.11", "26.04", "niri 26.04 (abc)"]) {
      it("accepts supported version " + value, async () => {
        version = value;
        await checkNiriCaptureSupport(socketPath);
      });
    }

    for (const [name, reply] of [
      ["invalid JSON", "garbage\n"],
      ["oversized unterminated JSON", "x".repeat(4 * 1024 * 1024 + 1)],
      ["invalid reply envelope", "{}\n"],
      ["invalid version type", '{"Ok":{"Version":42}}\n'],
    ] as const) {
      it("rejects " + name, async () => {
        handler = async (_request, socket) => {
          socket.write(reply);
        };
        await assert.rejects(
          checkNiriCaptureSupport(socketPath),
          /invalid|oversized/,
        );
      });
    }

    it("fails promptly when the compositor disconnects", async () => {
      handler = async (_request, socket) => {
        socket.end();
      };
      await assert.rejects(checkNiriCaptureSupport(socketPath), /disconnected/);
    });

    const invalidWindows: unknown[] = [
      {},
      { ...originalWindow, id: -1 },
      { ...originalWindow, id: Number.MAX_SAFE_INTEGER + 1 },
      { ...originalWindow, id: "42" },
      { ...originalWindow, pid: 0 },
      { ...originalWindow, pid: 1.5 },
      { ...originalWindow, title: 12 },
      { ...originalWindow, app_id: undefined },
      { ...originalWindow, layout: { window_size: [800, 0] } },
      { ...originalWindow, layout: { window_size: [800, 600, 1] } },
    ];
    for (const [index, invalid] of invalidWindows.entries()) {
      it("rejects malformed focused window " + index, async () => {
        const original = handler;
        handler = async (request, socket) => {
          if (request === "FocusedWindow") {
            send(socket, { Ok: { FocusedWindow: invalid } });
          } else {
            await original(request, socket);
          }
        };
        await assert.rejects(capture(), /invalid response/);
        assert.equal(capturePath, undefined);
      });
    }

    it("rejects malformed post-capture identity", async () => {
      const original = handler;
      handler = async (request, socket) => {
        if (request === "Windows") {
          send(socket, { Ok: { Windows: [{ id: 42 }] } });
        } else {
          await original(request, socket);
        }
      };
      await assert.rejects(capture(), /invalid response/);
      await assertPrivateCaptureRemoved();
    });

    it("times out without deleting unrelated paths", async () => {
      const other = NodePath.join(directory, "user-screenshot.png");
      await NodeFSP.writeFile(other, png);
      const original = handler;
      handler = async (request, socket) => {
        if (typeof request !== "string" && request.Action.ScreenshotWindow) {
          capturePath = request.Action.ScreenshotWindow.path;
          await NodeFSP.writeFile(capturePath, png);
          for (const event of events)
            send(event, { ScreenshotCaptured: { path: other } });
          send(socket, { Ok: "Handled" });
        } else {
          await original(request, socket);
        }
      };
      await assert.rejects(capture(), /timed out/);
      await assertPrivateCaptureRemoved();
      assert.deepEqual(await NodeFSP.readFile(other), png);
      assert.equal(calls.includes("Windows"), false);
    });

    it("rejects non-PNG files before decoding", async () => {
      const original = handler;
      handler = async (request, socket) => {
        if (typeof request !== "string" && request.Action.ScreenshotWindow) {
          capturePath = request.Action.ScreenshotWindow.path;
          await NodeFSP.writeFile(capturePath, "not PNG");
          for (const event of events)
            send(event, { ScreenshotCaptured: { path: capturePath } });
          send(socket, { Ok: "Handled" });
        } else {
          await original(request, socket);
        }
      };
      let decoded = false;
      await assert.rejects(
        capture({
          createImage: () => {
            decoded = true;
            return fakeImage();
          },
        }),
        /Invalid or oversized/,
      );
      assert.equal(decoded, false);
      await assertPrivateCaptureRemoved();
    });

    for (const bytes of [20 * 1024 * 1024 + 1, 32 * 1024 * 1024 + 1]) {
      it("rejects an image exceeding a byte limit: " + bytes, async () => {
        const original = handler;
        handler = async (request, socket) => {
          if (typeof request !== "string" && request.Action.ScreenshotWindow) {
            capturePath = request.Action.ScreenshotWindow.path;
            await NodeFSP.writeFile(capturePath, png);
            await NodeFSP.truncate(capturePath, bytes);
            for (const event of events)
              send(event, { ScreenshotCaptured: { path: capturePath } });
            send(socket, { Ok: "Handled" });
          } else {
            await original(request, socket);
          }
        };
        await assert.rejects(capture(), /size limit|Invalid screenshot file/);
        await assertPrivateCaptureRemoved();
      });
    }

    it("rejects empty or invalid decoded dimensions", async () => {
      await assert.rejects(
        capture({
          createImage: () => ({
            ...fakeImage(),
            isEmpty: () => true,
          }),
        }),
        /screenshot is empty/,
      );
      await assertPrivateCaptureRemoved();
      await assert.rejects(
        capture({ createImage: () => fakeImage(0, 600) }),
        /Invalid window screenshot dimensions/,
      );
      await assertPrivateCaptureRemoved();
    });

    it("scales pixels without changing logical bounds", async () => {
      const sizes: Array<{
        width: number;
        height: number;
        quality: string;
      }> = [];
      const snapshot = await capture({
        createImage: () => ({
          ...fakeImage(5120, 3200),
          resize: (size) => {
            sizes.push(size);
            return fakeImage(size.width, size.height);
          },
        }),
      });
      assert.deepEqual(sizes, [{ width: 2560, height: 1600, quality: "best" }]);
      assert.equal(snapshot.width, 2560);
      assert.equal(snapshot.height, 1600);
      assert.deepEqual(snapshot.window?.bounds, {
        x: 0,
        y: 0,
        width: 800,
        height: 600,
      });
      await assertPrivateCaptureRemoved();
    });

    it("also enforces the host byte limit on resized output", async () => {
      const oversized = Buffer.alloc(20 * 1024 * 1024 + 1);
      png.copy(oversized);
      await assert.rejects(
        capture({ createImage: () => fakeImage(5120, 3200, oversized) }),
        /Invalid or oversized/,
      );
      await assertPrivateCaptureRemoved();
    });

    for (const explicitExclusions of [false, true]) {
      it("excludes its own PID: " + explicitExclusions, async () => {
        focused = { ...originalWindow, pid: process.pid };
        await assert.rejects(
          capture(explicitExclusions ? { excludedPids: [] } : {}),
          /cannot capture its own application/,
        );
        assert.equal(capturePath, undefined);
        assert.equal(
          calls.some((call) => typeof call !== "string"),
          false,
        );
      });
    }

    it("excludes additional host-owned PIDs before taking pixels", async () => {
      await assert.rejects(
        capture({ excludedPids: [originalWindow.pid] }),
        /cannot capture its own application/,
      );
      assert.equal(capturePath, undefined);
      assert.equal(
        calls.some((call) => typeof call !== "string"),
        false,
      );
    });

    it("keeps null PID distinct from excluded PID zero", async () => {
      focused = { ...originalWindow, pid: null };
      windows = [structuredClone(focused)];
      const snapshot = await capture({ excludedPids: [0] });
      assert.equal(snapshot.window?.pid, null);
      await assertPrivateCaptureRemoved();
    });

    it("does not start an already-cancelled capture", async () => {
      const abort = new AbortController();
      abort.abort();
      await assert.rejects(capture({ signal: abort.signal }), {
        name: "AbortError",
      });
      assert.deepEqual(calls, []);
      assert.equal(getEventListeners(abort.signal, "abort").length, 0);
    });

    for (const stage of [
      "Version",
      "EventStream",
      "FocusedWindow",
      "Windows",
    ]) {
      it("cancels a pending socket wait: " + stage, async () => {
        const abort = new AbortController();
        let markReached: () => void = () => undefined;
        const reached = new Promise<void>((resolve) => {
          markReached = resolve;
        });
        const original = handler;
        handler = async (request, socket) => {
          if (request === stage) markReached();
          else await original(request, socket);
        };
        const pending = capture({ signal: abort.signal });
        const rejected = assert.rejects(pending, { name: "AbortError" });
        await reached;
        abort.abort();
        await rejected;
        if (capturePath) await assertPrivateCaptureRemoved();
        assert.equal(getEventListeners(abort.signal, "abort").length, 0);
      });
    }

    it("cancels an accepted screenshot while awaiting its event", async () => {
      const abort = new AbortController();
      let markReached: () => void = () => undefined;
      const reached = new Promise<void>((resolve) => {
        markReached = resolve;
      });
      const original = handler;
      handler = async (request, socket) => {
        if (typeof request !== "string" && request.Action.ScreenshotWindow) {
          capturePath = request.Action.ScreenshotWindow.path;
          await NodeFSP.writeFile(capturePath, png);
          send(socket, { Ok: "Handled" });
          markReached();
        } else {
          await original(request, socket);
        }
      };
      const pending = capture({ signal: abort.signal });
      const rejected = assert.rejects(pending, { name: "AbortError" });
      await reached;
      abort.abort();
      await rejected;
      await assertPrivateCaptureRemoved();
      assert.equal(calls.includes("Windows"), false);
      assert.equal(getEventListeners(abort.signal, "abort").length, 0);
    });

    it("discards decoded pixels after cancellation", async () => {
      const abort = new AbortController();
      await assert.rejects(
        capture({
          signal: abort.signal,
          createImage: () => {
            abort.abort();
            return fakeImage();
          },
        }),
        { name: "AbortError" },
      );
      assert.equal(calls.includes("Windows"), false);
      await assertPrivateCaptureRemoved();
      assert.equal(getEventListeners(abort.signal, "abort").length, 0);
    });

    it("removes abort listeners after a successful capture", async () => {
      const abort = new AbortController();
      await capture({ signal: abort.signal });
      assert.equal(getEventListeners(abort.signal, "abort").length, 0);
      abort.abort();
      await assertPrivateCaptureRemoved();
    });
  },
);
