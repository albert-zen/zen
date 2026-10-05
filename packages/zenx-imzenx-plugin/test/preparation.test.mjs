import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFixturePluginHost } from "@zenx/plugin-sdk";
import { ImZenXRuntime } from "../dist/runtime.js";

const invoke = (
  runtime,
  name,
  args = {},
  signal = new AbortController().signal,
) => runtime.invoke(name, { arguments: args, signal });
async function waitFor(check) {
  const until = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const SECRET = "do-not-return-private-secret";
const codes = [
  "python_ready",
  "sdk_ready",
  "workspace_ready",
  "channels_ready",
  "allowlist_ready",
  "credentials_ready",
];

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "imzenx-preparation-"));
  const receipts = path.join(root, "events.jsonl");
  const executable = path.join(root, "python-fixture");
  await writeFile(
    executable,
    `#!${process.execPath}\nimport fs from 'node:fs';import readline from 'node:readline';const probe=process.argv.includes('-I')&&!process.argv.includes('-c');const lines=readline.createInterface({input:process.stdin});const record=event=>fs.appendFileSync(${JSON.stringify(receipts)},JSON.stringify({event,pid:process.pid})+'\\n');lines.once('line',line=>{record(probe?'probe':'start');if(probe){process.stderr.write(${JSON.stringify(SECRET)});process.stdout.write(${JSON.stringify(JSON.stringify(options.probe ?? { codes, enabledChannels: ["qq"], secret: SECRET }))});process.exit(0);}else { const payload=JSON.parse(line); fs.writeFileSync(${JSON.stringify(path.join(root, "pipe-flags.json"))},JSON.stringify({receivedViaStdin:payload.IMZEN_CHANNELS_CONFIG?.qq?.client_secret===${JSON.stringify(SECRET)},secretInArgv:JSON.stringify(process.argv).includes(${JSON.stringify(SECRET)}),secretInEnvironment:JSON.stringify(process.env).includes(${JSON.stringify(SECRET)})})); process.stdout.write('{"type":"ready"}\\n');}});lines.once('close',()=>{if(!probe)record('stop');process.exit(0);});`,
    { mode: 0o700 },
  );
  let ready = options.ready ?? true;
  let descriptorReads = 0;
  const listeners = new Set();
  const host = {
    dataDirectory: root,
    isServerReady: () => ready,
    onServerStatus: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    readConnection: async () => {
      descriptorReads++;
      return {
        url: "ws://127.0.0.1:4500",
        authentication: { tokenFile: path.join(root, "token") },
      };
    },
  };
  const { sdk } = createFixturePluginHost({ pluginId: "imzenx" });
  const runtime = new ImZenXRuntime(host);
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  await runtime.start(sdk);
  runtime.activate(Promise.resolve());
  await waitFor(() => runtime.status().state === "unconfigured");
  const config = {
    pythonExecutable: executable,
    channelsConfigFile: path.join(root, "channels.json"),
    cwd: root,
  };
  return {
    runtime,
    sdk,
    host,
    config,
    root,
    receipts,
    descriptorReads: () => descriptorReads,
    notify(value) {
      ready = value;
      for (const fn of listeners) fn();
    },
    async events() {
      try {
        return (await readFile(receipts, "utf8"))
          .trim()
          .split("\n")
          .map(JSON.parse);
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
    },
  };
}

test("manifest exposes ordinary permissioned prepare and bounded read-only readiness", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../zenx.plugin.json", import.meta.url), "utf8"),
  );
  const prepare = manifest.tools.find((tool) => tool.name === "imzenx_prepare");
  const readiness = manifest.tools.find(
    (tool) => tool.name === "imzenx_readiness",
  );
  const connect = manifest.tools.find((tool) => tool.name === "imzenx_connect");
  assert.deepEqual(prepare.permissions, ["imzenx.configure"]);
  assert.deepEqual(readiness.permissions, ["imzenx.inspect"]);
  assert.deepEqual(connect.permissions, ["imzenx.connect"]);
  assert.equal(
    connect.inputSchema.properties.singleConsumerConfirmed.type,
    "boolean",
  );
  assert.equal(prepare.inputSchema.additionalProperties, false);
  assert.ok(
    manifest.contributions.commands.some((command) => command.id === "prepare"),
  );
  assert.ok(
    manifest.contributions.commands.some(
      (command) => command.id === "readiness",
    ),
  );
});

test(
  "save-only preparation cannot launch on save, server notification or restart",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const saved = await invoke(f.runtime, "imzenx_prepare", f.config);
    assert.equal(saved.state, "prepared");
    assert.equal(saved.explicitConnectRequired, true);
    assert.equal(saved.singleConsumerConfirmationRequired, true);
    assert.equal(saved.configuration.permissionMode, "approval-required");
    assert.equal(saved.activeConfiguration, null);
    assert.equal(f.descriptorReads(), 0);
    assert.deepEqual(await f.events(), []);
    f.notify(false);
    await waitFor(() => f.runtime.status().state === "prepared");
    f.notify(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await f.runtime.close();
    await f.runtime.start(f.sdk);
    f.runtime.activate(Promise.resolve());
    await waitFor(() => f.runtime.status().state === "prepared");
    assert.equal(f.descriptorReads(), 0);
    assert.deepEqual(await f.events(), []);
    assert.equal((await f.sdk.storage.get()).explicitConnectRequired, true);
  },
);

test(
  "prepared connect requires acknowledgement and legacy configure cannot bypass it",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    await invoke(f.runtime, "imzenx_prepare", f.config);
    const saved = await f.sdk.storage.get();
    await assert.rejects(
      invoke(f.runtime, "imzenx_connect"),
      /singleConsumerConfirmed/,
    );
    await assert.rejects(
      invoke(f.runtime, "imzenx_connect", { singleConsumerConfirmed: false }),
      /singleConsumerConfirmed/,
    );
    await assert.rejects(
      invoke(f.runtime, "imzenx_configure", f.config),
      /singleConsumerConfirmed/,
    );
    assert.deepEqual(await f.sdk.storage.get(), saved);
    assert.deepEqual(await f.events(), []);
    const connected = await invoke(f.runtime, "imzenx_connect", {
      singleConsumerConfirmed: true,
    });
    assert.equal(connected.state, "connected");
    assert.equal(connected.explicitConnectRequired, false);
    assert.match(connected.connectionMeaning, /not verified/);
    assert.equal(
      (await f.events()).filter(({ event }) => event === "start").length,
      1,
    );
    await f.runtime.close();
    await f.runtime.start(f.sdk);
    f.runtime.activate(Promise.resolve());
    await waitFor(() => f.runtime.status().state === "connected");
    assert.equal(
      (await f.events()).filter(({ event }) => event === "start").length,
      2,
    );
    await assert.rejects(
      invoke(f.runtime, "imzenx_connect"),
      /singleConsumerConfirmed/,
    );
  },
);

test(
  "save-only while connected keeps active paths truthful and never restarts the live consumer",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    await invoke(f.runtime, "imzenx_configure", f.config);
    const next = {
      ...f.config,
      channelsConfigFile: path.join(f.root, "pending-channels.json"),
    };
    const prepared = await invoke(f.runtime, "imzenx_prepare", next);
    assert.equal(prepared.state, "connected");
    assert.equal(
      prepared.configuration.channelsConfigFile,
      next.channelsConfigFile,
    );
    assert.equal(
      prepared.activeConfiguration.channelsConfigFile,
      f.config.channelsConfigFile,
    );
    assert.equal((await f.events()).length, 1);
    f.notify(false);
    await waitFor(() => f.runtime.status().state === "prepared");
    assert.equal(f.runtime.status().activeConfiguration, null);
    f.notify(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      (await f.events()).filter(({ event }) => event === "start").length,
      1,
    );
    const connected = await invoke(f.runtime, "imzenx_connect", {
      singleConsumerConfirmed: true,
    });
    assert.equal(
      connected.activeConfiguration.channelsConfigFile,
      next.channelsConfigFile,
    );
  },
);

test(
  "concurrent explicit connects join each old child before launching its replacement",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    await invoke(f.runtime, "imzenx_prepare", f.config);
    await Promise.all(
      Array.from({ length: 3 }, () =>
        invoke(f.runtime, "imzenx_connect", { singleConsumerConfirmed: true }),
      ),
    );
    const events = await f.events();
    assert.deepEqual(
      events.map(({ event }) => event),
      ["start", "stop", "start", "stop", "start"],
    );
    assert.equal(
      new Set(
        events.filter(({ event }) => event === "start").map(({ pid }) => pid),
      ).size,
      3,
    );
  },
);

test(
  "readiness launches only the bounded probe, returns fixed vocabulary and mutates nothing",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const before = await f.sdk.storage.get();
    const result = await invoke(f.runtime, "imzenx_readiness", f.config);
    assert.equal(result.ready, true);
    assert.deepEqual(result.enabledChannels, ["qq"]);
    assert.equal(result.connectionState, "unconfigured");
    assert.equal(result.singleConsumerConfirmationRequired, true);
    assert.deepEqual(await f.sdk.storage.get(), before);
    assert.equal(f.runtime.status().configuration, null);
    assert.equal(f.descriptorReads(), 0);
    assert.deepEqual(
      (await f.events()).map(({ event }) => event),
      ["probe"],
    );
    assert.ok(!JSON.stringify(result).includes(SECRET));
    await invoke(f.runtime, "imzenx_prepare", f.config);
    const saved = await f.sdk.storage.get();
    const savedProbe = await invoke(f.runtime, "imzenx_readiness");
    assert.equal(savedProbe.connectionState, "prepared");
    assert.deepEqual(await f.sdk.storage.get(), saved);
    assert.equal(f.runtime.status().state, "prepared");
  },
);

test(
  "missing SDK produces a trusted practical setup action without automatic install",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t, {
      probe: {
        codes: codes.map((code) =>
          code === "sdk_ready" ? "sdk_missing" : code,
        ),
        enabledChannels: ["qq"],
      },
    });
    const result = await invoke(f.runtime, "imzenx_readiness", f.config);
    assert.equal(result.ready, false);
    const sdk = result.checks.find((check) => check.id === "sdk");
    assert.equal(sdk.status, "blocked");
    assert.match(sdk.action, /Prepare runtime/);
    assert.match(sdk.action, /uv sync --project apps\/imzen --locked/);
    assert.match(sdk.action, /private repository access/);
    assert.equal(f.runtime.status().state, "unconfigured");
    assert.deepEqual(
      (await f.events()).map(({ event }) => event),
      ["probe"],
    );
  },
);

test(
  "raw probe diagnostics, unknown codes, channel names and malformed receipts cannot leak",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t, {
      probe: { codes: [SECRET], enabledChannels: [SECRET] },
    });
    const result = await invoke(f.runtime, "imzenx_readiness", f.config);
    assert.equal(result.ready, false);
    assert.equal(result.checks[0].id, "runtime");
    assert.ok(!JSON.stringify(result).includes(SECRET));
    assert.deepEqual(result.enabledChannels, []);
  },
);

test("unconfigured and stopped server checks are actionable; secret arguments are rejected before saving", async () => {
  const { sdk } = createFixturePluginHost({ pluginId: "imzenx" });
  const runtime = new ImZenXRuntime({
    dataDirectory: os.tmpdir(),
    isServerReady: () => false,
    onServerStatus: () => () => {},
    readConnection: async () => {
      throw new Error("Unexpected");
    },
  });
  try {
    await runtime.start(sdk);
    runtime.activate(Promise.resolve());
    await waitFor(() => runtime.status().state === "unconfigured");
    const result = await invoke(runtime, "imzenx_readiness");
    assert.equal(result.ready, false);
    assert.equal(
      result.checks.find((check) => check.id === "configuration").status,
      "blocked",
    );
    assert.equal(
      result.checks.find((check) => check.id === "server").status,
      "blocked",
    );
    await assert.rejects(
      invoke(runtime, "imzenx_prepare", {
        pythonExecutable: "/python",
        channelsConfigFile: "/channels",
        cwd: "/work",
        appsecret: SECRET,
      }),
      /only nonsecret/,
    );
    assert.deepEqual(await sdk.storage.get(), {});
    assert.ok(!JSON.stringify(runtime.status()).includes(SECRET));
  } finally {
    await runtime.close();
  }
});

test("real stdlib-only probe uses selected Python and own private QQ file without IM launch", async (t) => {
  const python =
    process.env.IMZEN_READINESS_TEST_PYTHON ?? "/usr/bin/python3.13";
  try {
    await access(python);
  } catch {
    t.skip("No configured Python test runtime");
    return;
  }
  const f = await fixture(t);
  const credentials = path.join(f.root, "qq.json");
  await writeFile(
    credentials,
    JSON.stringify({ appid: "12345", appsecret: SECRET }),
    { mode: 0o600 },
  );
  await writeFile(
    f.config.channelsConfigFile,
    JSON.stringify({
      qq: {
        enabled: true,
        credentials_file: credentials,
        allowed_user_ids: ["trusted"],
      },
    }),
  );
  const result = await invoke(f.runtime, "imzenx_readiness", {
    ...f.config,
    pythonExecutable: python,
  });
  assert.deepEqual(result.enabledChannels, ["qq"]);
  assert.equal(
    result.checks.find((check) => check.id === "python").status,
    "ready",
  );
  assert.equal(
    result.checks.find((check) => check.id === "credentials").status,
    "ready",
  );
  assert.equal(f.descriptorReads(), 0);
  assert.equal(f.runtime.status().state, "unconfigured");
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.deepEqual(await f.events(), []);
});

test("private Host connection failures do not enter status or tool errors", async () => {
  const { sdk } = createFixturePluginHost({ pluginId: "imzenx" });
  const runtime = new ImZenXRuntime({
    dataDirectory: os.tmpdir(),
    isServerReady: () => true,
    onServerStatus: () => () => {},
    readConnection: async () => {
      throw new Error(SECRET);
    },
  });
  try {
    await runtime.start(sdk);
    runtime.activate(Promise.resolve());
    await waitFor(() => runtime.status().state === "unconfigured");
    await assert.rejects(
      invoke(runtime, "imzenx_configure", {
        pythonExecutable: "/python",
        channelsConfigFile: "/channels",
        cwd: "/work",
      }),
      (error) =>
        error.message ===
        "IM Gateway failed to start. Check Python and channel configuration.",
    );
    assert.ok(!JSON.stringify(runtime.status()).includes(SECRET));
  } finally {
    await runtime.close();
  }
});

test(
  "managed readiness uses only safe Host flags and sends decrypted config only over Gateway private stdin",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t, {
      probe: {
        codes: ["python_ready", "sdk_ready", "workspace_ready"],
        enabledChannels: [],
      },
    });
    let secretReads = 0;
    let managedInspections = 0;
    let project;
    f.host.setRuntimeProject = (directory) => {
      project = directory;
    };
    f.host.inspectManagedChannels = async (file) => {
      assert.equal(file, f.config.channelsConfigFile);
      managedInspections++;
      return {
        channels: [
          {
            id: "qq",
            enabled: true,
            credentialsConfigured: true,
            accessRestricted: true,
          },
        ],
      };
    };
    f.host.readManagedChannels = async (file) => {
      assert.equal(file, f.config.channelsConfigFile);
      secretReads++;
      return {
        qq: {
          enabled: true,
          app_id: "12345",
          client_secret: SECRET,
          allowed_user_ids: ["trusted"],
        },
      };
    };
    await f.runtime.close();
    await f.runtime.start(f.sdk);
    f.runtime.activate(Promise.resolve());
    await waitFor(() => f.runtime.status().state === "unconfigured");
    assert.ok(project.endsWith(`${path.sep}python${path.sep}`));
    const result = await invoke(f.runtime, "imzenx_readiness", f.config);
    assert.equal(result.ready, true);
    assert.deepEqual(result.enabledChannels, ["qq"]);
    assert.equal(managedInspections, 1);
    assert.equal(secretReads, 0);
    assert.ok(!JSON.stringify(result).includes(SECRET));
    await invoke(f.runtime, "imzenx_prepare", f.config);
    assert.equal(secretReads, 0);
    await invoke(f.runtime, "imzenx_connect", {
      singleConsumerConfirmed: true,
    });
    assert.equal(secretReads, 1);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(f.root, "pipe-flags.json"), "utf8")),
      {
        receivedViaStdin: true,
        secretInArgv: false,
        secretInEnvironment: false,
      },
    );
    assert.ok(!JSON.stringify(f.runtime.status()).includes(SECRET));
    assert.ok(!JSON.stringify(await f.sdk.storage.get()).includes(SECRET));
  },
);

test(
  "managed missing credential flags block readiness without decrypting credentials",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t, {
      probe: {
        codes: ["python_ready", "sdk_ready", "workspace_ready"],
        enabledChannels: [],
      },
    });
    f.host.inspectManagedChannels = async () => ({
      channels: [
        {
          id: "telegram",
          enabled: true,
          credentialsConfigured: false,
          accessRestricted: true,
        },
      ],
    });
    f.host.readManagedChannels = async () => {
      throw new Error("Unexpected secret read");
    };
    const result = await invoke(f.runtime, "imzenx_readiness", f.config);
    assert.equal(result.ready, false);
    assert.equal(
      result.checks.find((check) => check.id === "credentials").status,
      "blocked",
    );
    assert.equal(f.runtime.status().state, "unconfigured");
  },
);

test(
  "Connect admitted during a pending managed save rejects stale confirmation and requires a fresh explicit call",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    let edit;
    f.host.registerManagedEdit = (callback) => {
      edit = callback;
      return () => {
        if (edit === callback) edit = undefined;
      };
    };
    let credential = SECRET;
    const readCredentials = [];
    f.host.readManagedChannels = async () => {
      readCredentials.push(credential);
      return {
        qq: {
          enabled: true,
          app_id: "12345",
          client_secret: credential,
          allowed_user_ids: ["trusted"],
        },
      };
    };
    await f.runtime.close();
    await f.runtime.start(f.sdk);
    f.runtime.activate(Promise.resolve());
    await waitFor(() => edit !== undefined);
    await invoke(f.runtime, "imzenx_configure", f.config);
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let entered;
    const enteredPromise = new Promise((resolve) => {
      entered = resolve;
    });
    const save = edit(f.config.channelsConfigFile, async () => {
      entered();
      await held;
      credential = SECRET + "-replacement";
      return "saved";
    });
    await enteredPromise;
    assert.equal((await f.sdk.storage.get()).explicitConnectRequired, true);
    assert.equal(f.runtime.status().explicitConnectRequired, true);
    assert.equal(f.runtime.status().state, "connected");
    let connectSettled = false;
    const connect = invoke(f.runtime, "imzenx_connect", {
      singleConsumerConfirmed: true,
    }).then(
      (value) => {
        connectSettled = true;
        return value;
      },
      (error) => {
        connectSettled = true;
        return error;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(connectSettled, false);
    assert.deepEqual(readCredentials, [SECRET]);
    assert.deepEqual(
      (await f.events()).map(({ event }) => event),
      ["start"],
    );
    release();
    assert.equal(await save, "saved");
    const stale = await connect;
    assert.ok(stale instanceof Error);
    assert.match(stale.message, /settings changed.*Review.*Connect again/);
    assert.equal(f.runtime.status().explicitConnectRequired, true);
    assert.equal((await f.sdk.storage.get()).explicitConnectRequired, true);
    assert.deepEqual(readCredentials, [SECRET]);
    assert.deepEqual(
      (await f.events()).map(({ event }) => event),
      ["start"],
    );
    assert.equal(
      (
        await invoke(f.runtime, "imzenx_connect", {
          singleConsumerConfirmed: true,
        })
      ).state,
      "connected",
    );
    assert.deepEqual(readCredentials, [SECRET, SECRET + "-replacement"]);
    assert.deepEqual(
      (await f.events()).map(({ event }) => event),
      ["start", "stop", "start"],
    );
  },
);

test(
  "managed edit gate survives restart and retired callbacks cannot edit a later generation",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    let edit;
    f.host.registerManagedEdit = (callback) => {
      edit = callback;
      return () => {
        if (edit === callback) edit = undefined;
      };
    };
    await f.runtime.close();
    await f.runtime.start(f.sdk);
    f.runtime.activate(Promise.resolve());
    await waitFor(() => edit !== undefined);
    await invoke(f.runtime, "imzenx_configure", f.config);
    const retiredEdit = edit;
    await edit(f.config.channelsConfigFile, async () => "saved");
    assert.equal((await f.sdk.storage.get()).explicitConnectRequired, true);
    await f.runtime.close();
    assert.equal(edit, undefined);
    await f.runtime.start(f.sdk);
    f.runtime.activate(Promise.resolve());
    await waitFor(() => f.runtime.status().state === "prepared");
    assert.equal(f.runtime.status().explicitConnectRequired, true);
    assert.equal(
      (await f.events()).filter(({ event }) => event === "start").length,
      1,
    );
    let called = false;
    await assert.rejects(
      retiredEdit(f.config.channelsConfigFile, async () => {
        called = true;
      }),
      /stopped/,
    );
    assert.equal(called, false);
  },
);

test("unpublished and waiting predecessor runtimes do not register managed edit or change setup source", async () => {
  const { sdk } = createFixturePluginHost({ pluginId: "imzenx" });
  const calls = [];
  const runtime = new ImZenXRuntime({
    dataDirectory: os.tmpdir(),
    isServerReady: () => false,
    onServerStatus: () => () => {},
    readConnection: async () => {
      throw new Error("Unexpected");
    },
    setRuntimeProject: () => calls.push("project"),
    registerManagedEdit: () => {
      calls.push("register");
      return () => calls.push("unregister");
    },
  });
  let release;
  const retired = new Promise((resolve) => {
    release = resolve;
  });
  await runtime.start(sdk);
  assert.deepEqual(calls, []);
  runtime.activate(retired);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, []);
  release();
  await waitFor(() => runtime.status().state === "unconfigured");
  assert.deepEqual(calls, ["project", "register"]);
  await runtime.close();
  assert.deepEqual(calls, ["project", "register", "unregister"]);
});

test(
  "a malicious workspace imzen package cannot shadow trusted Gateway code or receive private stdin",
  { skip: process.platform === "win32" },
  async (t) => {
    const python =
      process.env.IMZEN_READINESS_TEST_PYTHON ?? "/usr/bin/python3.13";
    try {
      await access(python);
    } catch {
      t.skip("No configured Python test runtime");
      return;
    }
    const f = await fixture(t);
    const { mkdir } = await import("node:fs/promises");
    const shadow = path.join(f.root, "imzen");
    const stolen = path.join(f.root, "workspace-stolen.json");
    await mkdir(shadow);
    await writeFile(path.join(shadow, "__init__.py"), "");
    await writeFile(
      path.join(shadow, "zenx.py"),
      `import sys\nfrom pathlib import Path\nPath(${JSON.stringify(stolen)}).write_text(sys.stdin.readline())\nprint('{"type":"ready"}',flush=True)\nfor line in sys.stdin: pass\n`,
    );
    const isolated = path.join(f.root, "python-without-sdk");
    // Test-only wrapper disables site packages, so the trusted module fails before
    // any real SDK transport could start. No dependency is installed or fetched.
    await writeFile(
      isolated,
      `#!${python}\nimport os,sys\nos.execv(${JSON.stringify(python)},[${JSON.stringify(python)},"-S",*sys.argv[1:]])\n`,
      { mode: 0o700 },
    );
    f.host.readManagedChannels = async () => ({
      qq: {
        enabled: true,
        app_id: "12345",
        client_secret: SECRET,
        allowed_user_ids: ["trusted"],
      },
    });
    await assert.rejects(
      invoke(f.runtime, "imzenx_configure", {
        ...f.config,
        pythonExecutable: isolated,
      }),
      /failed to start/,
    );
    await assert.rejects(access(stolen), (error) => error.code === "ENOENT");
    assert.equal(f.runtime.status().state, "failed");
    assert.ok(!JSON.stringify(f.runtime.status()).includes(SECRET));
  },
);

test(
  "queued Connect cannot bypass a configuration preparation committed after its admission",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const prepare = invoke(f.runtime, "imzenx_prepare", f.config);
    const connect = invoke(f.runtime, "imzenx_connect", {
      singleConsumerConfirmed: true,
    });
    await prepare;
    await assert.rejects(connect, /settings changed.*Review.*Connect again/);
    assert.equal(f.runtime.status().state, "prepared");
    assert.equal((await f.sdk.storage.get()).explicitConnectRequired, true);
    assert.equal(f.descriptorReads(), 0);
    assert.deepEqual(await f.events(), []);
  },
);

test(
  "failed managed edits still invalidate waiting Connect and preserve the durable gate",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    let edit;
    f.host.registerManagedEdit = (callback) => {
      edit = callback;
      return () => {
        if (edit === callback) edit = undefined;
      };
    };
    await f.runtime.close();
    await f.runtime.start(f.sdk);
    f.runtime.activate(Promise.resolve());
    await waitFor(() => edit !== undefined);
    await invoke(f.runtime, "imzenx_configure", f.config);
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let entered;
    const enteredPromise = new Promise((resolve) => {
      entered = resolve;
    });
    const save = edit(f.config.channelsConfigFile, async () => {
      entered();
      await held;
      throw new Error("synthetic partial-save failure");
    });
    const saveRejected = assert.rejects(save, /partial-save/);
    await enteredPromise;
    const connectRejected = assert.rejects(
      invoke(f.runtime, "imzenx_connect", { singleConsumerConfirmed: true }),
      /settings changed.*Review.*Connect again/,
    );
    release();
    await saveRejected;
    await connectRejected;
    assert.equal((await f.sdk.storage.get()).explicitConnectRequired, true);
    assert.equal(f.runtime.status().explicitConnectRequired, true);
    assert.deepEqual(
      (await f.events()).map(({ event }) => event),
      ["start"],
    );
  },
);

test(
  "first managed save invalidates queued Configure before its marker is selected",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    let edit;
    f.host.registerManagedEdit = (callback) => {
      edit = callback;
      return () => {
        if (edit === callback) edit = undefined;
      };
    };
    let credentialReads = 0;
    f.host.readManagedChannels = async () => {
      credentialReads++;
      return {
        qq: {
          enabled: true,
          app_id: "12345",
          client_secret: SECRET,
          allowed_user_ids: ["trusted"],
        },
      };
    };
    await f.runtime.close();
    await f.runtime.start(f.sdk);
    f.runtime.activate(Promise.resolve());
    await waitFor(() => edit !== undefined);
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let entered;
    const enteredPromise = new Promise((resolve) => {
      entered = resolve;
    });
    const save = edit(f.config.channelsConfigFile, async () => {
      entered();
      await held;
      return "saved";
    });
    await enteredPromise;
    const staleConfigure = assert.rejects(
      invoke(f.runtime, "imzenx_configure", {
        ...f.config,
        singleConsumerConfirmed: true,
      }),
      /settings changed.*Review.*Connect again/,
    );
    release();
    assert.equal(await save, "saved");
    await staleConfigure;
    assert.equal(f.runtime.status().state, "unconfigured");
    assert.equal(f.runtime.status().configuration, null);
    assert.deepEqual(await f.sdk.storage.get(), {});
    assert.equal(credentialReads, 0);
    assert.equal(f.descriptorReads(), 0);
    assert.deepEqual(await f.events(), []);
    const connected = await invoke(f.runtime, "imzenx_configure", {
      ...f.config,
      singleConsumerConfirmed: true,
    });
    assert.equal(connected.state, "connected");
    assert.equal(credentialReads, 1);
    assert.deepEqual(
      (await f.events()).map(({ event }) => event),
      ["start"],
    );
  },
);

test(
  "an unrelated managed edit does not invalidate Connect to unchanged selected settings",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    let edit;
    f.host.registerManagedEdit = (callback) => {
      edit = callback;
      return () => {
        if (edit === callback) edit = undefined;
      };
    };
    await f.runtime.close();
    await f.runtime.start(f.sdk);
    f.runtime.activate(Promise.resolve());
    await waitFor(() => edit !== undefined);
    await invoke(f.runtime, "imzenx_configure", f.config);
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let entered;
    const enteredPromise = new Promise((resolve) => {
      entered = resolve;
    });
    const save = edit(
      path.join(f.root, "unselected-managed.json"),
      async () => {
        entered();
        await held;
        return "saved";
      },
    );
    await enteredPromise;
    const connect = invoke(f.runtime, "imzenx_connect", {
      singleConsumerConfirmed: true,
    });
    release();
    await save;
    assert.equal((await connect).state, "connected");
    assert.equal(f.runtime.status().explicitConnectRequired, false);
    assert.equal(
      f.runtime.status().configuration.channelsConfigFile,
      f.config.channelsConfigFile,
    );
    assert.deepEqual(
      (await f.events()).map(({ event }) => event),
      ["start", "stop", "start"],
    );
  },
);
