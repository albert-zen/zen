import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it, type TestContext } from "node:test";
import {
  captureMacAppShotWindow,
  type MacAppShotOptions,
} from "../src/main/app-shot-macos.js";

const identity = {
  windowId: 42,
  pid: 777,
  windowTitle: "Chosen window",
  bounds: { x: 20, y: 30, width: 800, height: 600 },
};
function png(width = 800, height = 600) {
  const data = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data);
  data.writeUInt32BE(13, 8);
  data.write("IHDR", 12);
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}
function image(data: Buffer) {
  return {
    isEmpty: () => false,
    getSize: () => ({
      width: data.readUInt32BE(16),
      height: data.readUInt32BE(20),
    }),
    resize: (size: { width: number; height: number }) =>
      image(png(size.width, size.height)),
    toPNG: () => data,
  };
}
class Child extends EventEmitter {
  kills: string[] = [];
  kill(signal: string) {
    this.kills.push(signal);
    return true;
  }
}
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), "zenx-mac-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const child = new Child();
  let output = "";
  let starts = 0;
  let decodes = 0;
  let onStart = async () => {
    await fs.writeFile(output, png());
    child.emit("close", 0);
  };
  const options: MacAppShotOptions = {
    tempRoot: root,
    readMetadata: async () => identity,
    createImage: (data) => {
      decodes++;
      return image(data);
    },
    spawn: (file, args, settings) => {
      starts++;
      assert.equal(file, "/usr/sbin/screencapture");
      assert.deepEqual(args.slice(0, -1), [
        "-l",
        "42",
        "-o",
        "-x",
        "-t",
        "png",
      ]);
      assert.deepEqual(settings, { shell: false, stdio: "ignore" });
      output = args.at(-1)!;
      void onStart().catch((error: Error) => {
        child.emit("error", error);
        child.emit("close", 1);
      });
      return child;
    },
  };
  return {
    root,
    child,
    options,
    get output() {
      return output;
    },
    get starts() {
      return starts;
    },
    get decodes() {
      return decodes;
    },
    start(fn: typeof onStart) {
      onStart = fn;
    },
  };
}

it("captures one exact macOS surface in a private directory and cleans before returning", async (t) => {
  const h = await fixture(t);
  h.start(async () => {
    assert.equal((await fs.stat(dirname(h.output))).mode & 0o777, 0o700);
    await fs.writeFile(h.output, png(5120, 2880));
    h.child.emit("close", 0);
  });
  const result = await captureMacAppShotWindow(identity, h.options);
  assert.deepEqual(image(result).getSize(), { width: 2560, height: 1440 });
  assert.equal(h.starts, 1);
  assert.deepEqual(await fs.readdir(h.root), []);
});

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Synthetic condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

it("requires exact external metadata and excludes own windows before pixels", async (t) => {
  const h = await fixture(t);
  for (const invalid of [
    { ...identity, bounds: undefined },
    { ...identity, pid: 0 },
    { ...identity, pid: process.pid },
    { ...identity, windowTitle: " " },
    { ...identity, windowId: 0x1_0000_0000 },
  ])
    await assert.rejects(
      captureMacAppShotWindow(invalid, h.options),
      /exact external/,
    );
  await assert.rejects(
    captureMacAppShotWindow(identity, {
      ...h.options,
      excludedWindowIds: () => [42],
    }),
    /own window/,
  );
  await assert.rejects(
    captureMacAppShotWindow(identity, {
      ...h.options,
      readMetadata: async () => {
        throw new Error("metadata denied");
      },
    }),
    /metadata denied/,
  );
  assert.equal(h.starts, 0);
  assert.deepEqual(await fs.readdir(h.root), []);
});

for (const phase of ["before pixels", "after close"] as const) {
  it(`rejects PID/title/bounds drift ${phase} without fallback`, async (t) => {
    const h = await fixture(t);
    for (const changed of [
      { ...identity, pid: 778 },
      { ...identity, windowTitle: "Different" },
      { ...identity, bounds: { ...identity.bounds, x: 21 } },
      { ...identity, bounds: undefined },
    ]) {
      let reads = 0;
      await assert.rejects(
        captureMacAppShotWindow(identity, {
          ...h.options,
          readMetadata: async () =>
            ++reads === (phase === "before pixels" ? 2 : 3)
              ? changed
              : identity,
        }),
        /changed/,
      );
      assert.deepEqual(await fs.readdir(h.root), []);
    }
    assert.equal(h.starts, phase === "before pixels" ? 0 : 4);
    assert.equal(h.decodes, 0);
  });
}

it("rejects cancellation before setup and during asynchronous setup without spawning", async (t) => {
  const h = await fixture(t);
  const initial = new AbortController();
  initial.abort();
  await assert.rejects(
    captureMacAppShotWindow(identity, { ...h.options, signal: initial.signal }),
    /cancelled/,
  );
  const setup = new AbortController();
  await assert.rejects(
    captureMacAppShotWindow(identity, {
      ...h.options,
      signal: setup.signal,
      filesystem: {
        ...fs,
        chmod: async (...args) => {
          await fs.chmod(...args);
          setup.abort();
        },
      },
    }),
    /cancelled/,
  );
  assert.equal(h.starts, 0);
  assert.deepEqual(await fs.readdir(h.root), []);
});

for (const reason of ["cancel", "timeout", "error"] as const) {
  it(`${reason} kills only the owned capture child and waits for close before cleanup`, async (t) => {
    const h = await fixture(t);
    const controller = new AbortController();
    h.start(async () => {
      await fs.writeFile(h.output, png());
    });
    let settled = false;
    const result = captureMacAppShotWindow(identity, {
      ...h.options,
      signal: controller.signal,
      timeoutMs: reason === "timeout" ? 10 : 1000,
    }).finally(() => {
      settled = true;
    });
    const rejected = assert.rejects(
      result,
      reason === "cancel"
        ? /cancelled/
        : reason === "timeout"
          ? /timed out/
          : /process failed/,
    );
    await until(() => h.starts === 1);
    if (reason === "cancel") controller.abort();
    if (reason === "error")
      h.child.emit("error", new Error("synthetic spawn error"));
    await until(() => h.child.kills.length === 1);
    assert.deepEqual(h.child.kills, ["SIGKILL"]);
    assert.equal(settled, false);
    assert.equal((await fs.readdir(h.root)).length, 1);
    // exit is deliberately not close: output handles may still be live.
    h.child.emit("exit", 0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(settled, false);
    h.child.emit("close", 0);
    await rejected;
    assert.deepEqual(await fs.readdir(h.root), []);
    assert.equal(h.decodes, 0);
  });
}

it("reports unconfirmed shutdown, fences late pixels and defers cleanup until close", async (t) => {
  const h = await fixture(t);
  h.start(async () => {});
  await assert.rejects(
    captureMacAppShotWindow(identity, {
      ...h.options,
      timeoutMs: 5,
      shutdownGraceMs: 5,
    }),
    /shutdown and temporary-file cleanup could not be confirmed/,
  );
  assert.equal((await fs.readdir(h.root)).length, 1);
  await fs.writeFile(h.output, png());
  h.child.emit("close", 0);
  await until(async () => (await fs.readdir(h.root)).length === 0);
  assert.equal(h.decodes, 0);
});

it("cleans synchronous spawn failures and nonzero exit without retrying", async (t) => {
  const h = await fixture(t);
  await assert.rejects(
    captureMacAppShotWindow(identity, {
      ...h.options,
      spawn: () => {
        throw new Error("spawn refused");
      },
    }),
    /spawn refused/,
  );
  // A real child never emits close synchronously from spawn; use the same ordering here.
  h.start(async () => {
    await Promise.resolve();
    h.child.emit("close", 1);
  });
  await assert.rejects(
    captureMacAppShotWindow(identity, h.options),
    /Screen Recording permission/,
  );
  assert.equal(h.starts, 1);
  assert.deepEqual(await fs.readdir(h.root), []);
});

for (const kind of [
  "oversized bytes",
  "oversized dimensions",
  "bad header",
  "symlink",
  "hardlink",
  "missing",
] as const) {
  it(`rejects ${kind} before image decode and removes the transport file`, async (t) => {
    const h = await fixture(t);
    h.start(async () => {
      if (kind === "oversized bytes") {
        await fs.writeFile(h.output, png());
        await fs.truncate(h.output, 20 * 1024 * 1024 + 1);
      } else if (kind === "oversized dimensions")
        await fs.writeFile(h.output, png(16384, 16384));
      else if (kind === "bad header")
        await fs.writeFile(h.output, Buffer.alloc(33));
      else if (kind === "symlink" || kind === "hardlink") {
        const target = join(h.root, "synthetic-target.png");
        await fs.writeFile(target, png());
        if (kind === "symlink") await fs.symlink(target, h.output);
        else await fs.link(target, h.output);
      }
      await Promise.resolve();
      h.child.emit("close", 0);
    });
    await assert.rejects(captureMacAppShotWindow(identity, h.options));
    assert.equal(h.decodes, 0);
    assert.equal(
      (await fs.readdir(h.root)).some((name) =>
        name.startsWith("zenx-app-shot-mac-"),
      ),
      false,
    );
  });
}

it("rejects decoder mismatches, invalid resized output and late cancellation", async (t) => {
  const h = await fixture(t);
  await assert.rejects(
    captureMacAppShotWindow(identity, {
      ...h.options,
      createImage: () => image(png(1, 1)),
    }),
    /invalid image/,
  );
  h.start(async () => {
    await fs.writeFile(h.output, png(5120, 2880));
    h.child.emit("close", 0);
  });
  await assert.rejects(
    captureMacAppShotWindow(identity, {
      ...h.options,
      createImage: (data) => ({
        ...image(data),
        resize: () => image(png(1, 1)),
      }),
    }),
    /resized image/,
  );
  const controller = new AbortController();
  await assert.rejects(
    captureMacAppShotWindow(identity, {
      ...h.options,
      signal: controller.signal,
      createImage: (data) => {
        controller.abort();
        return image(data);
      },
    }),
    /cancelled/,
  );
  assert.deepEqual(await fs.readdir(h.root), []);
});

it("cleanup failure cannot return successful pixels, and abort during cleanup still wins", async (t) => {
  const h = await fixture(t);
  await assert.rejects(
    captureMacAppShotWindow(identity, {
      ...h.options,
      filesystem: {
        ...fs,
        rm: async () => {
          throw new Error("synthetic remove failure");
        },
      },
    }),
    /cleanup failed; capture was discarded/,
  );
  assert.equal((await fs.readdir(h.root)).length, 1);
  await fs.rm(dirname(h.output), { recursive: true });
  const controller = new AbortController();
  await assert.rejects(
    captureMacAppShotWindow(identity, {
      ...h.options,
      signal: controller.signal,
      filesystem: {
        ...fs,
        rm: async (...args) => {
          await fs.rm(...args);
          controller.abort();
        },
      },
    }),
    /cancelled/,
  );
  assert.deepEqual(await fs.readdir(h.root), []);
});
