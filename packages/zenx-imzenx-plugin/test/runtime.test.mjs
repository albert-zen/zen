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
  "channel facts survive the ready handshake, reject arbitrary fields, expire, and retire with the child",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "imzenx-channel-status-"),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const executable = path.join(root, "python-fixture");
    const facts = path.join(root, "facts.json");
    const writeFacts = (channels) =>
      writeFile(facts, JSON.stringify({ type: "channel-status", channels }));
    await writeFacts([{ id: "qq", state: "ready" }]);
    await writeFile(
      executable,
      `#!${process.execPath}\nimport fs from 'node:fs'; import readline from 'node:readline';const lines=readline.createInterface({input:process.stdin});let timer;lines.once('line',()=>{process.stdout.write('{"type":"ready"}\\n');timer=setInterval(()=>{try{process.stdout.write(fs.readFileSync(${JSON.stringify(facts)},'utf8')+'\\n');}catch{}},10);});lines.once('close',()=>{clearInterval(timer);process.exit(0);});`,
      { mode: 0o700 },
    );
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
    t.after(() => runtime.close());
    await runtime.start(sdk);
    runtime.activate(Promise.resolve());
    await waitFor(() => runtime.status().state === "unconfigured");
    await invoke(runtime, "imzenx_configure", {
      pythonExecutable: executable,
      channelsConfigFile: path.join(root, "channels.json"),
      cwd: root,
    });
    await waitFor(() => runtime.status().channels[0]?.state === "ready");
    await writeFacts([{ id: "qq", state: "reconnecting" }]);
    await waitFor(() => runtime.status().channels[0]?.state === "reconnecting");
    await writeFacts([
      { id: "qq", state: "ready", session_id: "private-session" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(runtime.status().channels, [
      { id: "qq", state: "reconnecting" },
    ]);
    assert.equal(
      JSON.stringify(runtime.status()).includes("private-session"),
      false,
    );
    const future = performance.now() + 10001;
    t.mock.method(performance, "now", () => future);
    assert.deepEqual(runtime.status().channels, [
      { id: "qq", state: "unknown" },
    ]);
    t.mock.restoreAll();
    await writeFacts([{ id: "qq", state: "ready" }]);
    await waitFor(() => runtime.status().channels[0]?.state === "ready");
    await runtime.close();
    assert.deepEqual(runtime.status().channels, []);
  },
);
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
      runtime.activate(Promise.resolve());
      await waitFor(() => runtime.status().state !== "waiting-for-activation");
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
      // Host reuses this exact object on disable → enable.
      await runtime.start(sdk);
      runtime.activate(Promise.resolve());
      await waitFor(() => runtime.status().state !== "waiting-for-activation");
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
  runtime.activate(Promise.resolve());
  await waitFor(() => runtime.status().state !== "waiting-for-activation");
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
    runtime.activate(Promise.resolve());
    await waitFor(() => runtime.status().state !== "waiting-for-activation");
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

test("a closed pending activation cannot revive and re-enable reloads cleared storage", async () => {
  const { sdk } = createFixturePluginHost({ pluginId: "imzenx" });
  const listeners = new Set();
  const runtime = new ImZenXRuntime({
    dataDirectory: os.tmpdir(),
    isServerReady: () => false,
    onServerStatus: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readConnection: async () => {
      throw new Error("unexpected connection");
    },
  });
  await sdk.storage.set({
    configuration: {
      pythonExecutable: "/old/python",
      channelsConfigFile: "/old/channels.json",
      cwd: "/old",
    },
  });
  let release;
  const retired = new Promise((resolve) => {
    release = resolve;
  });
  await runtime.start(sdk);
  runtime.activate(retired);
  await runtime.close();
  await sdk.storage.set({});
  await runtime.start(sdk);
  runtime.activate(Promise.resolve());
  await waitFor(() => runtime.status().state === "unconfigured");
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.status().configuration, null);
  assert.equal(listeners.size, 1);
  await runtime.close();
  assert.equal(listeners.size, 0);
});

test(
  "the actual child pipe routes PAW requests after readiness within configured workspace",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "imzenx-paw-runtime-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const executable = path.join(root, "python-fixture");
    const responseFile = path.join(root, "response.json");
    await writeFile(
      executable,
      `#!${process.execPath}\nimport fs from 'node:fs';import readline from 'node:readline';let first=true;const lines=readline.createInterface({input:process.stdin});lines.on('line',line=>{if(first){first=false;process.stdout.write('{"type":"ready"}\\n');setImmediate(()=>process.stdout.write('{"type":"paw-request","id":"p1","operation":"list","params":{}}\\n'));}else fs.writeFileSync(${JSON.stringify(responseFile)},line);});lines.once('close',()=>process.exit(0));`,
      { mode: 0o700 },
    );
    const requests = [];
    const runtime = new ImZenXRuntime({
      dataDirectory: root,
      isServerReady: () => true,
      onServerStatus: () => () => {},
      readConnection: async () => ({
        url: "ws://127.0.0.1:4500",
        authentication: { tokenFile: path.join(root, "token") },
      }),
      pawRequest: async (...args) => {
        requests.push(args);
        return { rooms: [{ id: "r", name: "PAW" }] };
      },
    });
    t.after(() => runtime.close());
    const { sdk } = createFixturePluginHost({ pluginId: "imzenx" });
    await runtime.start(sdk);
    runtime.activate(Promise.resolve());
    await waitFor(() => runtime.status().state === "unconfigured");
    await invoke(runtime, "imzenx_configure", {
      pythonExecutable: executable,
      channelsConfigFile: path.join(root, "channels.json"),
      cwd: root,
    });
    await waitFor(() => requests.length === 1);
    let response;
    for (let i = 0; i < 100; i++) {
      try {
        response = JSON.parse(await readFile(responseFile, "utf8"));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    assert.deepEqual(requests, [[root, "list", {}]]);
    assert.deepEqual(response, {
      type: "paw-response",
      id: "p1",
      result: { rooms: [{ id: "r", name: "PAW" }] },
    });
  },
);

for (const code of ["state_migration_blocked", "unknown_failure"]) {
  test(
    `child startup failure ${code} has a fixed safe explanation`,
    { skip: process.platform === "win32" },
    async (t) => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "imzenx-state-failure-"),
      );
      t.after(() => rm(root, { recursive: true, force: true }));
      const executable = path.join(root, "python-fixture");
      const failure = JSON.stringify({
        type: "failed",
        code,
        error: "/private/workspace secret-token",
      });
      await writeFile(
        executable,
        `#!${process.execPath}\nimport readline from 'node:readline';const lines=readline.createInterface({input:process.stdin});lines.once('line',()=>process.stdout.write(${JSON.stringify(failure + "\n")}));lines.once('close',()=>process.exit(0));`,
        { mode: 0o700 },
      );
      const runtime = new ImZenXRuntime({
        dataDirectory: root,
        isServerReady: () => true,
        onServerStatus: () => () => {},
        readConnection: async () => ({
          url: "ws://127.0.0.1:4500",
          authentication: { tokenFile: path.join(root, "token") },
        }),
      });
      t.after(() => runtime.close());
      const { sdk } = createFixturePluginHost({ pluginId: "imzenx" });
      await runtime.start(sdk);
      runtime.activate(Promise.resolve());
      await waitFor(() => runtime.status().state === "unconfigured");
      await assert.rejects(
        invoke(runtime, "imzenx_configure", {
          pythonExecutable: executable,
          channelsConfigFile: path.join(root, "channels.json"),
          cwd: root,
        }),
        code === "state_migration_blocked"
          ? /original database and any backup are preserved/
          : /Check Python and channel configuration/,
      );
      assert.equal(runtime.status().state, "failed");
      assert.doesNotMatch(
        JSON.stringify(runtime.status()),
        /secret-token|private\/workspace/,
      );
    },
  );
}

test(
  "state preparation grants one bounded readiness extension",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "imzenx-state-preparation-"),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const executable = path.join(root, "python-fixture");
    const output =
      [
        { type: "preparing-state" },
        { type: "preparing-state" },
        { type: "ready" },
      ]
        .map(JSON.stringify)
        .join("\n") + "\n";
    await writeFile(
      executable,
      `#!${process.execPath}\nimport readline from 'node:readline';const lines=readline.createInterface({input:process.stdin});lines.once('line',()=>process.stdout.write(${JSON.stringify(output)}));lines.once('close',()=>process.exit(0));`,
      { mode: 0o700 },
    );
    const delays = [];
    const originalTimeout = globalThis.setTimeout;
    t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
      delays.push(delay);
      return originalTimeout(callback, delay, ...args);
    });
    const runtime = new ImZenXRuntime({
      dataDirectory: root,
      isServerReady: () => true,
      onServerStatus: () => () => {},
      readConnection: async () => ({
        url: "ws://127.0.0.1:4500",
        authentication: { tokenFile: path.join(root, "token") },
      }),
    });
    t.after(() => runtime.close());
    const { sdk } = createFixturePluginHost({ pluginId: "imzenx" });
    await runtime.start(sdk);
    runtime.activate(Promise.resolve());
    await waitFor(() => runtime.status().state === "unconfigured");
    await invoke(runtime, "imzenx_configure", {
      pythonExecutable: executable,
      channelsConfigFile: path.join(root, "channels.json"),
      cwd: root,
    });
    assert.equal(runtime.status().state, "connected");
    assert.equal(delays.filter((delay) => delay === 15000).length, 1);
    assert.equal(delays.filter((delay) => delay === 120000).length, 1);
  },
);
