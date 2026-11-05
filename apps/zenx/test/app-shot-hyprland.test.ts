import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  captureHyprlandActiveAppShot,
  getHyprlandAppShotState,
  hyprlandAppShotHelperPath,
  isHyprlandSession,
  HYPRLAND_APP_SHOT_BUILD,
  type HyprlandAppShotOptions,
} from "../src/main/app-shot-hyprland.js";
import type { NiriAppShotImage } from "../src/main/app-shot-niri.js";

const version = {
  protocolVersion: 1,
  buildId: HYPRLAND_APP_SHOT_BUILD,
  helperVersion: "0.1.0",
  upstreamRevision: "337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17",
};
const capabilities = {
  ...version,
  captureAvailable: true,
  mappingVersion: 1,
  exportVersion: 2,
  feedbackAvailable: false,
};
const env = {
  XDG_CURRENT_DESKTOP: "Hyprland",
  XDG_RUNTIME_DIR: "/run/user/1000",
  HYPRLAND_INSTANCE_SIGNATURE: "test_123",
};
const window = {
  title: "Editor",
  appName: "editor",
  appIdentifier: "editor",
  processId: 123456789,
  bounds: { x: -1920, y: 0, width: 800, height: 600 },
  clientBounds: { x: -1920, y: 0, width: 800, height: 600 },
};
function png(width = 800, height = 600): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
function image(width = 800, height = 600): NiriAppShotImage {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toPNG: () => png(width, height),
    resize: (size) => image(size.width, size.height),
  };
}

it("recognizes the native desktop, rejecting stale and sandbox environments", () => {
  assert.equal(isHyprlandSession(env), true);
  assert.equal(
    isHyprlandSession({ ...env, XDG_CURRENT_DESKTOP: "OTHER:hyprland" }),
    true,
  );
  for (const override of [
    { XDG_CURRENT_DESKTOP: "GNOME" },
    { XDG_CURRENT_DESKTOP: "not-hyprland" },
    { FLATPAK_ID: "" },
    { SNAP: "" },
    { SNAP_NAME: "zenx" },
  ])
    assert.equal(isHyprlandSession({ ...env, ...override }), false);
  assert.throws(
    () => hyprlandAppShotHelperPath({ dataHome: "relative" }),
    /absolute/,
  );
  assert.equal(
    hyprlandAppShotHelperPath({ dataHome: "/data" }),
    "/data/zenx/hyprland-capture/zenx-hyprland-snap-shot",
  );
});

describe(
  "Hyprland core host client with synthetic helper and PNG decoder",
  { skip: process.platform !== "linux" },
  () => {
    let root: string;
    let executable: string;
    let calls: string[][];
    let captureDirectory: string | undefined;
    let options: HyprlandAppShotOptions;
    let capture: (args: readonly string[]) => Promise<string>;
    beforeEach(async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), "zenx-hyprland-test-"));
      executable = hyprlandAppShotHelperPath({ dataHome: root });
      await fs.mkdir(path.dirname(executable), {
        recursive: true,
        mode: 0o700,
      });
      await fs.writeFile(executable, "synthetic installed helper", {
        mode: 0o700,
      });
      calls = [];
      captureDirectory = undefined;
      capture = async (args) => {
        captureDirectory = args[1];
        assert.ok(captureDirectory);
        assert.equal((await fs.stat(captureDirectory)).mode & 0o777, 0o700);
        await fs.writeFile(path.join(captureDirectory, "capture.png"), png());
        return JSON.stringify({ window });
      };
      options = {
        dataHome: root,
        env,
        createImage: () => image(),
        runHelper: async (file, args) => {
          assert.equal(file, executable);
          calls.push([...args]);
          if (args[0] === "version") return JSON.stringify(version);
          if (args[0] === "check") return JSON.stringify(capabilities);
          assert.equal(args[0], "capture");
          return capture(args);
        },
      };
    });
    afterEach(async () => {
      await fs.rm(root, { recursive: true, force: true });
    });
    async function removed(): Promise<void> {
      assert.ok(captureDirectory);
      await assert.rejects(fs.stat(captureDirectory), { code: "ENOENT" });
    }

    it("probes version and capabilities without capture or writes", async () => {
      const before = await fs.stat(executable);
      const state = await getHyprlandAppShotState(options);
      assert.equal(state.status, "ready");
      assert.equal(state.feedbackAvailable, false);
      assert.deepEqual(calls, [["version"], ["check"]]);
      assert.equal((await fs.stat(executable)).mtimeMs, before.mtimeMs);
      assert.equal(captureDirectory, undefined);
    });
    it("reports missing setup without installing or spawning", async () => {
      await fs.unlink(executable);
      assert.equal(
        (await getHyprlandAppShotState(options)).status,
        "not-installed",
      );
      assert.deepEqual(calls, []);
      await assert.rejects(
        captureHyprlandActiveAppShot(options),
        /manual setup/,
      );
      await assert.rejects(fs.stat(executable), { code: "ENOENT" });
    });
    it("reports old helper without update or capture", async () => {
      options.runHelper = async (_, args) => {
        calls.push([...args]);
        return JSON.stringify({ ...version, buildId: "old" });
      };
      assert.equal(
        (await getHyprlandAppShotState(options)).status,
        "update-required",
      );
      await assert.rejects(captureHyprlandActiveAppShot(options), /outdated/);
      assert.deepEqual(calls, [["version"], ["version"]]);
      assert.equal(
        await fs.readFile(executable, "utf8"),
        "synthetic installed helper",
      );
    });
    it("rejects invalid protocol capabilities without capture", async () => {
      options.runHelper = async (_, args) =>
        JSON.stringify(
          args[0] === "version"
            ? version
            : { ...capabilities, exportVersion: 1 },
        );
      const state = await getHyprlandAppShotState(options);
      assert.equal(state.status, "error");
      assert.match(state.message, /export v2/);
    });
    it("rejects malformed or oversized version replies as setup errors", async () => {
      for (const reply of ["not-json", "[]", "x".repeat(128 * 1024 + 1)]) {
        options.runHelper = async () => reply;
        assert.equal(
          (await getHyprlandAppShotState(options)).status,
          "update-required",
        );
      }
    });
    it("rejects writable, non-executable and symlink helpers before spawn", async () => {
      for (const mode of [0o777, 0o770, 0o600]) {
        await fs.chmod(executable, mode);
        assert.equal((await getHyprlandAppShotState(options)).status, "error");
      }
      await fs.unlink(executable);
      await fs.symlink("/bin/true", executable);
      assert.equal((await getHyprlandAppShotState(options)).status, "error");
      assert.deepEqual(calls, []);
    });
    it("rejects mutable dedicated directories before spawn", async () => {
      await fs.chmod(path.dirname(executable), 0o777);
      assert.equal((await getHyprlandAppShotState(options)).status, "error");
      assert.deepEqual(calls, []);
    });
    it("rejects sandbox and invalid session environment without helper execution", async () => {
      assert.equal(
        (
          await getHyprlandAppShotState({
            ...options,
            env: { ...env, SNAP: "/snap/app" },
          })
        ).status,
        "unsupported-session",
      );
      assert.equal(
        (
          await getHyprlandAppShotState({
            ...options,
            env: { ...env, HYPRLAND_INSTANCE_SIGNATURE: "../../escape" },
          })
        ).status,
        "error",
      );
      assert.equal(
        (
          await getHyprlandAppShotState({
            ...options,
            env: { ...env, XDG_RUNTIME_DIR: "relative" },
          })
        ).status,
        "error",
      );
      assert.deepEqual(calls, []);
    });
    it("returns validated pixels and original identity, excluding host PIDs and cleaning temp files", async () => {
      const result = await captureHyprlandActiveAppShot({
        ...options,
        excludedPids: [999, process.pid],
      });
      assert.deepEqual(result, { png: png(), width: 800, height: 600, window });
      assert.equal(calls[2]?.[2], `${process.pid},999`);
      await removed();
    });
    it("keeps image only when native post-capture identity drift drops metadata", async () => {
      const write = capture;
      capture = async (args) => {
        await write(args);
        return JSON.stringify({ window: null });
      };
      const result = await captureHyprlandActiveAppShot(options);
      assert.equal(result.window, undefined);
      assert.deepEqual(result.png, png());
      await removed();
    });
    it("rejects malformed metadata or excluded process identities and cleans output", async () => {
      const write = capture;
      for (const changed of [
        {},
        { ...window, processId: process.pid },
        { ...window, title: "a".repeat(4097) },
        { ...window, bounds: { ...window.bounds, width: 0 } },
      ]) {
        capture = async (args) => {
          await write(args);
          return JSON.stringify({ window: changed });
        };
        await assert.rejects(
          captureHyprlandActiveAppShot(options),
          /metadata|own application/,
        );
        await removed();
      }
    });
    it("never follows a PNG symlink or removes its target", async () => {
      const target = path.join(root, "keep.png");
      await fs.writeFile(target, png());
      capture = async (args) => {
        captureDirectory = args[1]!;
        await fs.symlink(target, path.join(captureDirectory, "capture.png"));
        return JSON.stringify({ window: null });
      };
      await assert.rejects(
        captureHyprlandActiveAppShot(options),
        /symbolic|ELOOP/,
      );
      assert.deepEqual(await fs.readFile(target), png());
      await removed();
    });
    it("bounds PNG dimensions before native decoding", async () => {
      capture = async (args) => {
        captureDirectory = args[1]!;
        await fs.writeFile(
          path.join(captureDirectory, "capture.png"),
          png(16384, 16384),
        );
        return JSON.stringify({ window: null });
      };
      options.createImage = () => {
        throw new Error("Must not decode oversized pixels");
      };
      await assert.rejects(
        captureHyprlandActiveAppShot(options),
        /oversized.*dimensions/,
      );
      await removed();
    });
    it("rejects non-PNG or decoder dimension mismatches", async () => {
      options.createImage = () => image(1, 1);
      await assert.rejects(
        captureHyprlandActiveAppShot(options),
        /Invalid or empty/,
      );
      capture = async (args) => {
        captureDirectory = args[1]!;
        await fs.writeFile(
          path.join(captureDirectory, "capture.png"),
          Buffer.alloc(33),
        );
        return JSON.stringify({ window: null });
      };
      await assert.rejects(captureHyprlandActiveAppShot(options), /PNG header/);
      await removed();
    });
    it("resizes large valid captures within the common review bound", async () => {
      capture = async (args) => {
        captureDirectory = args[1]!;
        await fs.writeFile(
          path.join(captureDirectory, "capture.png"),
          png(5120, 3200),
        );
        return JSON.stringify({ window: null });
      };
      const result = await captureHyprlandActiveAppShot({
        ...options,
        createImage: () => image(5120, 3200),
      });
      assert.equal(result.width, 2560);
      assert.equal(result.height, 1600);
      await removed();
    });
    it("cleans after helper denial without retry or fallback", async () => {
      const write = capture;
      capture = async (args) => {
        await write(args);
        throw new Error("Sharing permission denied");
      };
      await assert.rejects(
        captureHyprlandActiveAppShot(options),
        /permission denied/,
      );
      assert.deepEqual(
        calls.map((args) => args[0]),
        ["version", "check", "capture"],
      );
      await removed();
    });
    it("cancels before spawning and after native completion", async () => {
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        getHyprlandAppShotState({ ...options, signal: controller.signal }),
        { name: "AbortError" },
      );
      assert.deepEqual(calls, []);
      const during = new AbortController();
      const write = capture;
      capture = async (args) => {
        const result = await write(args);
        during.abort();
        return result;
      };
      await assert.rejects(
        captureHyprlandActiveAppShot({ ...options, signal: during.signal }),
        { name: "AbortError" },
      );
      await removed();
    });
    it("actual child cancellation closes the process before deleting its capture directory", async () => {
      const marker = path.join(root, "child.json");
      await fs.writeFile(
        executable,
        `#!${process.execPath}\nconst fs = require('node:fs');\nconst command = process.argv[2];\nif (command === 'version') console.log(${JSON.stringify(JSON.stringify(version))});\nelse if (command === 'check') console.log(${JSON.stringify(JSON.stringify(capabilities))});\nelse { fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, directory: process.argv[3] })); setInterval(() => {}, 1000); }\n`,
        { mode: 0o700 },
      );
      const controller = new AbortController();
      const pending = captureHyprlandActiveAppShot({
        ...options,
        runHelper: undefined,
        signal: controller.signal,
      });
      const rejected = assert.rejects(pending, { name: "AbortError" });
      let child: { pid: number; directory: string } | undefined;
      for (let tries = 0; tries < 200; tries++) {
        try {
          child = JSON.parse(await fs.readFile(marker, "utf8"));
          break;
        } catch {
          await delay(10);
        }
      }
      controller.abort();
      await rejected;
      assert.ok(child, "synthetic child reached capture");
      assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
      await assert.rejects(fs.stat(child.directory), { code: "ENOENT" });
    });
  },
);
