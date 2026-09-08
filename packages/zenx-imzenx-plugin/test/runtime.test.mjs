import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFixturePluginHost } from "@zenx/plugin-sdk";
import { ImZenXRuntime } from "../dist/runtime.js";

const invoke = (runtime, name, args = {}) =>
  runtime.invoke(name, {
    arguments: args,
    signal: new AbortController().signal,
  });
async function waitFor(check) {
  const until = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
test(
  "configuration survives runtime replacement and only connects while ZAS is ready",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "imzenx-runtime-"));
    const executable = path.join(root, "python-fixture");
    const receipts = path.join(root, "starts.jsonl");
    const code = `#!${process.execPath}\nimport fs from 'node:fs'; import readline from 'node:readline'; const lines=readline.createInterface({input:process.stdin}); lines.once('line',line=>{fs.appendFileSync(${JSON.stringify(receipts)},line+'\\n'); process.stdout.write('{"type":"ready"}\\n');}); lines.once('close',()=>process.exit(0));`;
    await writeFile(executable, code, { mode: 0o700 });
    let ready = false;
    const listeners = new Set();
    const host = {
      dataDirectory: root,
      isServerReady: () => ready,
      onServerStatus: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      readConnection: async () => ({
        url: "ws://127.0.0.1:4500",
        authentication: { tokenFile: path.join(root, "token") },
      }),
    };
    const { sdk } = createFixturePluginHost({ pluginId: "imzenx" });
    let runtime = new ImZenXRuntime(host);
    try {
      await runtime.start(sdk);
      await invoke(runtime, "imzenx_configure", {
        pythonExecutable: executable,
        channelsConfigFile: path.join(root, "channels.json"),
        cwd: root,
      });
      assert.equal(runtime.status().state, "waiting-for-zas");
      ready = true;
      for (const listener of listeners) listener();
      await waitFor(() => runtime.status().state === "connected");
      let launches = (await readFile(receipts, "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.equal(launches.length, 1);
      assert.equal(launches[0].IMZEN_APP_SERVER_URL, "ws://127.0.0.1:4500");
      assert.equal(
        launches[0].IMZEN_APP_SERVER_AUTH_TOKEN_FILE,
        path.join(root, "token"),
      );
      ready = false;
      for (const listener of listeners) listener();
      await waitFor(() => runtime.status().state === "waiting-for-zas");
      await runtime.close();
      assert.equal(listeners.size, 0);
      runtime = new ImZenXRuntime(host);
      await runtime.start(sdk);
      ready = true;
      for (const listener of listeners) listener();
      await waitFor(() => runtime.status().state === "connected");
      launches = (await readFile(receipts, "utf8")).trim().split("\n");
      assert.equal(launches.length, 2);
      await runtime.close();
      assert.equal(runtime.status().state, "stopped");
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
test("invalid configuration is rejected before persisted configuration changes", async () => {
  const { sdk } = createFixturePluginHost({ pluginId: "imzenx" });
  const runtime = new ImZenXRuntime({
    dataDirectory: os.tmpdir(),
    isServerReady: () => false,
    onServerStatus: () => () => {},
    readConnection: async () => {
      throw new Error("unexpected");
    },
  });
  await runtime.start(sdk);
  await assert.rejects(
    invoke(runtime, "imzenx_configure", { pythonExecutable: "relative" }),
    /absolute path/,
  );
  assert.deepEqual(await sdk.storage.get(), {});
  await runtime.close();
});

test("missing Python fails promptly and remains failed until explicit reconnect", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "imzenx-failed-"));
  const { sdk } = createFixturePluginHost({ pluginId: "imzenx" });
  const runtime = new ImZenXRuntime({
    dataDirectory: root,
    isServerReady: () => true,
    onServerStatus: () => () => {},
    readConnection: async () => ({
      url: "ws://127.0.0.1:4500",
      authentication: { tokenFile: path.join(root, "token") },
    }),
  });
  try {
    await runtime.start(sdk);
    await assert.rejects(
      invoke(runtime, "imzenx_configure", {
        pythonExecutable: path.join(root, "missing-python"),
        channelsConfigFile: path.join(root, "channels.json"),
        cwd: root,
      }),
      /failed to start/,
    );
    assert.equal(runtime.status().state, "failed");
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
