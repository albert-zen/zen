import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { readFileSync, closeSync } from "node:fs";
import { once } from "node:events";
import {
  observeOwnedProcesses,
  parseProcessStat,
  openProcessDirectory,
  readProcessFile,
} from "../scripts/owned-process-observation.mjs";
const stat = (pid, ppid, start = 100, comm = "private name") =>
  `${pid} (${comm}) S ${ppid} ${Array(17).fill("0").join(" ")} ${start} 0 0\n`;
const status = (pid, ppid, rss = 300) =>
  `Name:\tSECRET\nPid:\t${pid}\nPPid:\t${ppid}\nVmRSS:\t${rss} kB\nVmSwap:\t0 kB\nThreads:\t3\n`;
function fixture({ children = "2", mutate = () => {} } = {}) {
  const calls = [],
    closed = [],
    opened = [];
  const files = new Map([
    ["1/stat", stat(1, 0)],
    ["1/task/1/children", children],
    ["2/stat", stat(2, 1)],
    ["2/status", status(2, 1)],
    ["2/task/2/children", "3"],
    ["3/stat", stat(3, 2)],
    ["3/status", status(3, 2)],
  ]);
  const options = {
    pid: 1,
    platform: "linux",
    mainThread: true,
    monotonic: () => 0,
    open: (id) => {
      opened.push(id);
      return id;
    },
    close: (fd) => closed.push(fd),
    read: (fd, suffix, limit) => {
      const path = `${fd}/${suffix}`;
      calls.push({ path, limit });
      mutate(files, path, calls);
      if (!files.has(path)) throw Error("SECRET");
      return files.get(path);
    },
  };
  return { options, calls, closed, opened, files };
}
test("stat parses final comm delimiter including parentheses/newlines and rejects malformed identity", () => {
  assert.deepEqual(parseProcessStat(stat(1, 0, 999, "a) (b\n) c")), {
    pid: 1,
    ppid: 0,
    startTicks: 999,
  });
  for (const input of [
    "",
    "1 () S 0",
    stat(1, 0, "9007199254740992"),
    stat(1, -1),
    "0 (x) S 0",
  ])
    assert.equal(parseProcessStat(input), null);
});
test("bounded anchored ancestry emits only fixed numeric projection, closes every opened FD", () => {
  const h = fixture();
  const r = observeOwnedProcesses(h.options);
  assert.equal(r.state, "observed");
  assert.equal(r.incomplete, true);
  assert.equal(r.nodes.length, 2);
  assert.deepEqual(r.nodes[1], {
    pid: 3,
    ppid: 2,
    startTicks: 100,
    depth: 2,
    rssKiB: 300,
    swapKiB: 0,
    threads: 3,
  });
  assert.deepEqual(h.closed, [3, 2, 1]);
  assert.ok(!JSON.stringify(r).includes("SECRET"));
  assert.ok(
    h.calls.every((c) =>
      /^\d+\/(stat|status|task\/\d+\/children)$/u.test(c.path),
    ),
  );
});
test("rejects changing child start ticks and changing PPid", () => {
  for (const changed of [stat(2, 1, 101), stat(2, 9)]) {
    let childReads = 0;
    const h = fixture({
      mutate: (files, path) => {
        if (path === "2/stat" && ++childReads === 2) files.set(path, changed);
      },
    });
    assert.equal(observeOwnedProcesses(h.options).nodes.length, 0);
    assert.deepEqual(h.closed, [2, 1]);
  }
});
test("rejects lost parent membership and ancestor identity", () => {
  for (const mode of ["membership", "identity"]) {
    let count = 0;
    const h = fixture({
      mutate: (files, path) => {
        if (path === "2/status") {
          if (mode === "membership") files.set("1/task/1/children", "");
          else files.set("1/stat", stat(1, 0, 101));
        }
        count++;
      },
    });
    const r = observeOwnedProcesses(h.options);
    assert.equal(r.nodes.length, 0);
    assert.ok(count > 0);
  }
});
test("invalid PID input, cycles, duplicates, unavailable root and oversized input fail closed", () => {
  for (const children of ["2 ../9", "-2", "2 NaN", "9".repeat(1025)]) {
    const h = fixture({ children });
    assert.equal(observeOwnedProcesses(h.options).nodes.length, 0);
    assert.deepEqual(h.opened, [1]);
  }
  const h = fixture({ children: "1 2 2" });
  const r = observeOwnedProcesses(h.options);
  assert.equal(r.nodes.length, 2);
  assert.equal(h.opened.filter((x) => x === 2).length, 1);
  h.files.delete("1/stat");
  assert.equal(observeOwnedProcesses(h.options).state, "unavailable");
});
test("missing or duplicate memory fields are null, zero remains zero", () => {
  const h = fixture();
  h.files.set("2/status", status(2, 1) + "VmRSS: 4 kB\n");
  const r = observeOwnedProcesses(h.options);
  assert.equal(r.nodes[0].rssKiB, null);
  assert.equal(r.nodes[0].swapKiB, 0);
});
test("candidate and depth ceilings constrain IO and descriptors", () => {
  const h = fixture({
    children: Array.from({ length: 20 }, (_, i) => i + 2).join(" "),
  });
  const r = observeOwnedProcesses(h.options);
  assert.equal(r.capped, true);
  assert.equal(r.candidates, 8);
  assert.ok(h.opened.length <= 9);
  assert.ok(r.reads <= 80);
  assert.ok(r.inputBytes <= 128 * 1024);
  assert.equal(h.closed.length, h.opened.length);
});
test("read quota/time stops additional IO, unsupported thread/platform does no IO", () => {
  const h = fixture();
  let now = 0;
  h.options.monotonic = () => (now += 101);
  const r = observeOwnedProcesses(h.options);
  assert.equal(r.capped, true);
  assert.equal(h.calls.length, 0);
  for (const override of [
    { mainThread: false },
    { platform: "darwin" },
    { pid: NaN },
  ]) {
    const h = fixture();
    assert.equal(
      observeOwnedProcesses({ ...h.options, ...override }).state,
      "unsupported",
    );
    assert.equal(h.opened.length, 0);
  }
});
test("throwing reads and close never escape observation", () => {
  const h = fixture();
  h.options.read = () => {
    throw Error("secret");
  };
  h.options.close = () => {
    throw Error("secret");
  };
  assert.equal(observeOwnedProcesses(h.options).state, "unavailable");
});
test(
  "real owned child is observed by identity and memory without reading argv/env",
  { skip: process.platform !== "linux" },
  async (t) => {
    try {
      readFileSync(`/proc/${process.pid}/task/${process.pid}/children`);
    } catch {
      if (process.env.GITHUB_ACTIONS === "true")
        assert.fail(
          "Ubuntu CI must support process-leader children for this experiment",
        );
      t.skip("process-leader children unavailable in this environment");
      return;
    }
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const b=Buffer.alloc(16*1024*1024,1); process.stdout.write('ready\\n'); setInterval(()=>b[0],1000);",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let anchored;
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error("owned fixture readiness exceeded 2s")),
          2000,
        );
        child.once("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.stdout.once("data", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      anchored = openProcessDirectory(child.pid);
      const r = observeOwnedProcesses();
      const row = r.nodes.find((n) => n.pid === child.pid);
      assert.ok(row, JSON.stringify(r));
      assert.equal(row.ppid, process.pid);
      assert.ok(row.rssKiB > 16000);
      assert.ok(row.startTicks > 0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const ended = once(child, "exit");
        child.kill();
        await ended;
      }
      if (anchored !== undefined) {
        try {
          assert.throws(() => readProcessFile(anchored, "stat", 4096));
        } finally {
          closeSync(anchored);
        }
      }
    }
  },
);
