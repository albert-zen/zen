import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createFixturePluginHost } from "@zenx/plugin-sdk";
import { ImZenXRuntime } from "../../../packages/zenx-imzenx-plugin/src/runtime.js";
import { ImZenXSetupService } from "../src/main/imzenx-setup-service.js";
import test from "node:test";
test(
  "secure same-marker bot edit rejects previously reviewed consent before starting a Gateway",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "astra-im-consent-"));
    const setup = new ImZenXSetupService({
      directory: path.join(root, "setup"),
      encryption: {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => "gnome_libsecret",
        encryptString: (v) => Buffer.from(v),
        decryptString: (v) => v.toString(),
      },
    });
    const python = path.join(root, "synthetic-python");
    const receipt = path.join(root, "receipt.json");
    await writeFile(
      python,
      `#!${process.execPath}\nconst fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});rl.once('line',line=>{if(!process.argv.includes('-c')){console.log(JSON.stringify({codes:['python_ready','sdk_ready','workspace_ready'],enabledChannels:[]}));process.exit(0);}const value=JSON.parse(line);fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({appId:value.IMZEN_CHANNELS_CONFIG.qq.app_id}));console.log('{"type":"ready"}');});rl.once('close',()=>process.exit(0));`,
      { mode: 0o700 },
    );
    const runtime = new ImZenXRuntime({
      dataDirectory: root,
      isServerReady: () => true,
      onServerStatus: () => () => {},
      readConnection: async () => ({
        url: "ws://127.0.0.1:1",
        authentication: { tokenFile: path.join(root, "synthetic-token") },
      }),
      setRuntimeProject: () => {},
      registerManagedEdit: (edit) => setup.registerManagedEdit(edit),
      readManagedChannels: (file) => setup.readManagedChannels(file),
      inspectManagedChannels: (file) => setup.inspectManagedChannels(file),
    });
    const { sdk } = createFixturePluginHost({ pluginId: "imzenx" });
    const invoke = (name: string, args: Record<string, unknown> = {}) =>
      runtime.invoke(name, {
        arguments: args,
        signal: new AbortController().signal,
      });
    const save = (id: string) =>
      setup.saveChannel({
        channelId: "qq",
        values: {
          enabled: true,
          app_id: id,
          allowed_user_ids: "synthetic-owner",
        },
        secrets: {
          client_secret: {
            operation: "replace",
            value: "synthetic-test-secret",
          },
        },
      });
    try {
      await runtime.start(sdk);
      runtime.activate(Promise.resolve());
      await new Promise((r) => setTimeout(r, 0));
      await save("111111");
      await invoke("imzenx_prepare", {
        pythonExecutable: python,
        channelsConfigFile: setup.configurationFile,
        cwd: root,
      });
      const reviewedStatus = runtime.status();
      const readiness = (await invoke("imzenx_readiness")) as {
        configurationRevision: string;
        ready: boolean;
      };
      assert.equal(readiness.ready, true);
      const oldAcknowledgement = {
        singleConsumerConfirmed: true,
        expectedConfigurationRevision: readiness.configurationRevision,
      };
      // Another trusted window finishes changing the bot after Window A reviewed it.
      await save("222222");
      assert.deepEqual(
        runtime.status().configuration,
        reviewedStatus.configuration,
      );
      await assert.rejects(
        invoke("imzenx_connect", oldAcknowledgement),
        /settings changed after readiness/,
      );
      await assert.rejects(readFile(receipt, "utf8"), { code: "ENOENT" });
      const refreshed = (await invoke("imzenx_readiness")) as {
        configurationRevision: string;
        ready: boolean;
      };
      const connected = (await invoke("imzenx_connect", {
        singleConsumerConfirmed: true,
        expectedConfigurationRevision: refreshed.configurationRevision,
      })) as { state: string };
      assert.equal(connected.state, "connected");
      const received = JSON.parse(await readFile(receipt, "utf8"));
      assert.equal(received.appId, "222222");
      assert.ok(
        !JSON.stringify(runtime.status()).includes("synthetic-test-secret"),
      );
    } finally {
      await runtime.close();
      await setup.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
