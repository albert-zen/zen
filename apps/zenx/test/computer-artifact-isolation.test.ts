import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { register } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { ElectronMacComputerBackend } from "../src/main/capabilities/computer-provider.js";
import { PeekabooComputerBackend } from "../src/main/capabilities/peekaboo-computer-provider.js";
import { WinAppCliComputerBackend } from "../src/main/capabilities/windows-computer-provider.js";

// A synthetic opaque 1px PNG, never a desktop capture or user file.
const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNwaDjwHwAFBAKAPJ4DgAAAAABJRU5ErkJggg==";
const png = Buffer.from(pngBase64, "base64");
const target = { pid: 42, windowTitle: "Synthetic artifact fixture" };
const ttl = 5 * 60_000;

// Node isolates this test file. This loader works at the Node 22.13 floor and
// never imports Electron, enumerates a desktop, or starts a native process.
register(
  `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      return specifier === 'electron'
        ? { url: 'zenx-test:artifact-electron', shortCircuit: true }
        : next(specifier, context);
    }
    export async function load(url, context, next) {
      return url === 'zenx-test:artifact-electron'
        ? { format: 'module', shortCircuit: true, source: ${JSON.stringify(`
          export const desktopCapturer = {
            async getSources() {
              return [{ id: 'window:7:0', thumbnail: {
                isEmpty: () => false,
                getSize: () => ({ width: 1, height: 1 }),
                toPNG: () => Buffer.from('${pngBase64}', 'base64'),
              } }];
            },
          };
        `)} }
        : next(url, context);
    }
  `)}`,
  import.meta.url,
);

function nativeBackend(t: TestContext, artifactDirectory?: string) {
  const backend = new ElectronMacComputerBackend(artifactDirectory);
  // Exercise the real target-session and screenshot writer with a fake native
  // transport, rather than replacing the production constructor or cleanup.
  t.mock.method(
    backend.targetSession.transport,
    "request",
    async (request: Record<string, unknown>) => {
      assert.ok(["select", "verify"].includes(request.operation as string));
      return {
        bindingId: "synthetic-binding",
        target: { ...target, applicationName: "Synthetic fixture" },
        windowId: 7,
        bounds: { x: 0, y: 0, width: 1, height: 1 },
      };
    },
  );
  return {
    async screenshot() {
      // Only the platform guard is simulated; every OS-facing operation above
      // is a recording double. This is not native macOS capture acceptance.
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: "darwin" });
      try {
        return await backend.screenshot(target, undefined, "synthetic-owner");
      } finally {
        Object.defineProperty(process, "platform", platform);
      }
    },
    close: () => backend.close(),
  };
}

function peekabooBackend(_t: TestContext, artifactDirectory?: string) {
  const backend = new PeekabooComputerBackend({
    executable: "/synthetic/peekaboo",
    artifactDirectory,
    runner: {
      async run(_executable, args) {
        assert.equal(args[0], "image");
        assert.equal(args[args.indexOf("--capture-focus") + 1], "background");
        await writeFile(args[args.indexOf("--path") + 1]!, png);
        return {
          stdout: JSON.stringify({ success: true, data: {} }),
          stderr: "",
        };
      },
    },
  });
  return {
    screenshot: () => backend.screenshot(target),
    close: () => backend.close(),
  };
}

function windowsBackend(_t: TestContext, artifactDirectory?: string) {
  const backend = new WinAppCliComputerBackend({
    artifactDirectory,
    platform: "win32",
    runner: {
      async run(_executable, args) {
        assert.deepEqual(args.slice(0, 2), ["ui", "list-windows"]);
        return {
          stdout: JSON.stringify([
            {
              hwnd: "7",
              processId: target.pid,
              processName: "Synthetic fixture",
              title: target.windowTitle,
              width: 1,
              height: 1,
            },
          ]),
          stderr: "",
        };
      },
    },
    captureRunner: {
      async run(_executable, _args, options) {
        assert.deepEqual(JSON.parse(options.stdin!), {
          hwnd: "7",
          pid: target.pid,
          title: target.windowTitle,
        });
        return {
          stdout: JSON.stringify({
            method: "strict-background-printwindow",
            hwnd: "7",
            processId: target.pid,
            windowTitle: target.windowTitle,
            width: 1,
            height: 1,
            pngBase64,
          }),
          stderr: "",
        };
      },
    },
  });
  return {
    screenshot: () => backend.screenshot(target),
    close: () => backend.close(),
  };
}

async function expectRemoved(file: string) {
  // The existing TTL callbacks unlink asynchronously. Observe their result,
  // without replacing production cleanup or using real five-minute sleeps.
  const deadline = performance.now() + 2_000;
  while (true) {
    try {
      await access(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    assert.ok(performance.now() < deadline, "owned artifact was not removed");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

for (const [provider, create, defaultRoot] of [
  ["native", nativeBackend, `zenx-capability-artifacts-${process.pid}`],
  ["Peekaboo", peekabooBackend, `zenx-peekaboo-${process.pid}`],
  ["WinApp", windowsBackend, `zenx-winapp-artifacts-${process.pid}`],
] as const) {
  for (const explicitRoot of [false, true]) {
    for (const expireBeforeClose of [false, true]) {
      test(`${provider}: ${explicitRoot ? "shared explicit" : "default"} root isolates generations (${expireBeforeClose ? "expire then close" : "close before expiry"})`, async (t) => {
        t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
        const root = explicitRoot
          ? await mkdtemp(path.join(os.tmpdir(), "zenx-artifact-isolation-"))
          : path.join(os.tmpdir(), defaultRoot);
        await mkdir(root, { recursive: true });
        // The caller's root, including unrelated source files, is not owned by
        // either generation. Recursive backend cleanup must leave it alone.
        const source = path.join(root, "caller-source.swift");
        await writeFile(source, "synthetic caller-owned source\n");
        const old = create(t, explicitRoot ? root : undefined);
        const current = create(t, explicitRoot ? root : undefined);
        t.after(async () => {
          await old.close();
          await current.close();
          await rm(root, { recursive: true, force: true });
        });
        const first = await old.screenshot();
        t.mock.timers.tick(1_000);
        const second = await current.screenshot();
        const currentHelperSource = path.join(
          path.dirname(second.artifactPath),
          "synthetic-helper.swift",
        );
        await writeFile(
          currentHelperSource,
          "synthetic instance-owned source\n",
        );
        assert.deepEqual(await readFile(first.artifactPath), png);
        assert.deepEqual(await readFile(second.artifactPath), png);
        assert.equal(Date.parse(first.expiresAt), 10_000 + ttl);
        assert.equal(Date.parse(second.expiresAt), 11_000 + ttl);

        if (expireBeforeClose) {
          t.mock.timers.tick(ttl - 1_000);
          await expectRemoved(first.artifactPath);
          assert.deepEqual(await readFile(second.artifactPath), png);
        }
        await old.close();
        await old.close();
        await expectRemoved(first.artifactPath);
        // This fails on the original implementation: old.close deletes the
        // shared root and the newer generation's still-unexpired screenshot.
        assert.deepEqual(await readFile(second.artifactPath), png);
        assert.equal(
          await readFile(currentHelperSource, "utf8"),
          "synthetic instance-owned source\n",
        );
        assert.notEqual(
          path.dirname(first.artifactPath),
          path.dirname(second.artifactPath),
        );
        assert.equal(path.dirname(path.dirname(second.artifactPath)), root);
        await expectRemoved(path.dirname(first.artifactPath));
        assert.equal(
          await readFile(source, "utf8"),
          "synthetic caller-owned source\n",
        );

        t.mock.timers.tick(expireBeforeClose ? 999 : ttl - 1);
        assert.deepEqual(await readFile(second.artifactPath), png);
        t.mock.timers.tick(1);
        await expectRemoved(second.artifactPath);
        await current.close();
        await current.close();
        await expectRemoved(path.dirname(second.artifactPath));
        assert.equal(
          await readFile(source, "utf8"),
          "synthetic caller-owned source\n",
        );
      });
    }
  }
}
