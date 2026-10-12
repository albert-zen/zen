import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ImZenXSetupService } from "../src/main/imzenx-setup-service.js";
import { ImRuntimeSetupOwnershipError } from "../src/main/imzenx-runtime-preparation.js";

const secret = "synthetic-im-test-credential";
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "imzenx-secure-setup-"));
  let available = true;
  const encryption = {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (value: string) =>
      Buffer.from([...value].reverse().join("")),
    decryptString: (value: Buffer) => [...value.toString()].reverse().join(""),
  };
  const service = new ImZenXSetupService({ directory: root, encryption });
  service.registerManagedEdit(async (_file, action) => action());
  return {
    root,
    service,
    encryption,
    disableEncryption: () => {
      available = false;
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
}
const saveQQ = (
  service: ImZenXSetupService,
  operation: "replace" | "keep" | "clear" = "replace",
) =>
  service.saveChannel({
    channelId: "qq",
    values: { enabled: true, app_id: "123456", allowed_user_ids: "user-one" },
    secrets: {
      client_secret: {
        operation,
        ...(operation === "replace" ? { value: secret } : {}),
      },
    },
  });

test("native IM save keeps secrets encrypted/write-only and supports keep, replace and clear", async () => {
  const f = await fixture();
  try {
    const saved = await saveQQ(f.service);
    assert.equal(
      saved.channels.find((channel) => channel.id === "qq")!.secretConfigured
        .client_secret,
      true,
    );
    assert.doesNotMatch(JSON.stringify(saved), new RegExp(secret));
    assert.doesNotMatch(
      await readFile(f.service.configurationFile, "utf8"),
      new RegExp(secret),
    );
    assert.doesNotMatch(
      await readFile(path.join(f.root, "credentials.vault"), "utf8"),
      new RegExp(secret),
    );
    assert.equal(
      (
        (await f.service.readManagedChannels(f.service.configurationFile))!
          .qq as any
      ).client_secret,
      secret,
    );
    await saveQQ(f.service, "keep");
    assert.equal(
      (
        (await f.service.readManagedChannels(f.service.configurationFile))!
          .qq as any
      ).client_secret,
      secret,
    );
    await f.service.saveChannel({
      channelId: "telegram",
      values: { enabled: true, allowed_user_ids: "telegram-user" },
      secrets: {
        bot_token: {
          operation: "replace",
          value: "synthetic-telegram-credential",
        },
      },
    });
    await saveQQ(f.service, "clear");
    const cleared = await f.service.inspect();
    assert.equal(
      cleared.channels.find((channel) => channel.id === "qq")!.secretConfigured
        .client_secret,
      false,
    );
    assert.equal(
      cleared.channels.find((channel) => channel.id === "telegram")!
        .secretConfigured.bot_token,
      true,
    );
    await assert.rejects(
      f.service.readManagedChannels(f.service.configurationFile),
      /Complete the selected channel/,
    );
    assert.equal(
      await f.service.readManagedChannels(path.join(f.root, "unrelated.json")),
      undefined,
    );
    const restarted = new ImZenXSetupService({
      directory: f.root,
      encryption: f.encryption,
    });
    assert.equal(
      (await restarted.inspect()).channels.find(
        (channel) => channel.id === "telegram",
      )!.secretConfigured.bot_token,
      true,
    );
  } finally {
    await f.close();
  }
});

test(
  "Linux basic_text encryption fails closed even when Electron reports encryption available",
  { skip: process.platform !== "linux" },
  async () => {
    const f = await fixture();
    try {
      const insecure = new ImZenXSetupService({
        directory: path.join(f.root, "insecure"),
        encryption: {
          ...f.encryption,
          getSelectedStorageBackend: () => "basic_text",
        },
      });
      insecure.registerManagedEdit(async (_file, action) => action());
      assert.equal((await insecure.inspect()).encryptionAvailable, false);
      await assert.rejects(saveQQ(insecure), /No plaintext fallback/);
      await assert.rejects(
        readFile(path.join(f.root, "insecure", "credentials.vault")),
        { code: "ENOENT" },
      );
    } finally {
      await f.close();
    }
  },
);

test("native IM rejects misplaced/malformed fields and never falls back to plaintext", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.service.saveChannel({
        channelId: "qq",
        values: { client_secret: secret },
        secrets: {},
      }),
      /could not be saved/,
    );
    await assert.rejects(
      f.service.saveChannel({
        channelId: "qq",
        values: { app_id: "bad-id" },
        secrets: {},
      }),
      /could not be saved/,
    );
    await assert.rejects(
      f.service.saveChannel({ channelId: "weixin", values: {}, secrets: {} }),
      /could not be saved/,
    );
    await saveQQ(f.service);
    f.disableEncryption();
    await assert.rejects(saveQQ(f.service), /No plaintext fallback/);
    assert.equal((await f.service.inspect()).encryptionAvailable, false);
    assert.doesNotMatch(
      await readFile(path.join(f.root, "credentials.vault"), "utf8"),
      new RegExp(secret),
    );
  } finally {
    await f.close();
  }
});

test("managed readiness uses only configured/access flags and encrypted read failures are redacted", async () => {
  const f = await fixture();
  try {
    await saveQQ(f.service);
    const result = await f.service.inspectManagedChannels(
      f.service.configurationFile,
    );
    assert.equal(
      result!.channels.find((channel) => channel.id === "qq")!
        .credentialsConfigured,
      true,
    );
    assert.equal(
      result!.channels.find((channel) => channel.id === "qq")!.accessRestricted,
      true,
    );
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    await writeFile(path.join(f.root, "credentials.vault"), secret);
    await assert.rejects(
      f.service.inspect(),
      (error: any) =>
        /Encrypted IM configuration/.test(error.message) &&
        !error.message.includes(secret),
    );
  } finally {
    await f.close();
  }
});

test("secure save requires admitted runtime and registration cleanup is identity-safe", async () => {
  const f = await fixture();
  try {
    const service = new ImZenXSetupService({
      directory: path.join(f.root, "admission"),
      encryption: f.encryption,
    });
    await assert.rejects(saveQQ(service), /Wait for activation/);
    const retireOld = service.registerManagedEdit(async (_file, action) =>
      action(),
    );
    service.registerManagedEdit(async (_file, action) => action());
    retireOld();
    await saveQQ(service);
    await service.close();
    await assert.rejects(saveQQ(service), /Wait for activation/);
  } finally {
    await f.close();
  }
});

test("Host shutdown cancels and joins runtime preparation without marking it ready", async () => {
  const f = await fixture();
  const source = path.join(f.root, "shutdown-project");
  await mkdir(path.join(source, "src"), { recursive: true });
  for (const name of ["pyproject.toml", "uv.lock", "README.md"])
    await writeFile(path.join(source, name), "synthetic");
  let running = false;
  const service = new ImZenXSetupService({
    directory: path.join(f.root, "shutdown"),
    encryption: f.encryption,
    runSetup: async (_project, signal) => {
      running = true;
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new Error("synthetic runtime stop")),
          { once: true },
        ),
      );
    },
  });
  service.setRuntimeProject(source);
  try {
    const preparing = service.prepareRuntime();
    while (!running) await new Promise((resolve) => setTimeout(resolve, 5));
    await service.close();
    const stopped = await preparing;
    assert.equal(stopped.runtime.preparing, false);
    assert.equal(stopped.runtime.prepared, false);
    await assert.rejects(service.prepareRuntime(), /stopped/);
  } finally {
    await f.close();
  }
});

test("unconfirmed setup process ownership blocks retries and reports shutdown failure", async () => {
  const f = await fixture();
  const source = path.join(f.root, "unconfirmed-project");
  await mkdir(path.join(source, "src"), { recursive: true });
  for (const name of ["pyproject.toml", "uv.lock", "README.md"])
    await writeFile(path.join(source, name), "synthetic");
  let attempts = 0;
  const service = new ImZenXSetupService({
    directory: path.join(f.root, "unconfirmed"),
    encryption: f.encryption,
    runSetup: async () => {
      attempts++;
      throw new ImRuntimeSetupOwnershipError();
    },
  });
  service.setRuntimeProject(source);
  try {
    const failed = await service.prepareRuntime();
    assert.match(failed.runtime.error!, /Further setup is blocked/);
    await service.prepareRuntime();
    assert.equal(attempts, 1);
    await assert.rejects(service.close(), /termination could not be confirmed/);
  } finally {
    await f.close();
  }
});

test("explicit runtime preparation copies the locked project, deduplicates calls and redacts errors", async () => {
  const f = await fixture();
  const source = path.join(f.root, "bundled-project");
  await mkdir(path.join(source, "src"), { recursive: true });
  for (const name of ["pyproject.toml", "uv.lock", "README.md"])
    await writeFile(path.join(source, name), `fixture ${name}`);
  let runs = 0;
  let release: (() => void) | undefined;
  const service = new ImZenXSetupService({
    directory: path.join(f.root, "setup"),
    encryption: f.encryption,
    runSetup: async (project) => {
      runs++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      const python = path.join(
        project,
        ".venv",
        process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
      );
      await mkdir(path.dirname(python), { recursive: true });
      await writeFile(python, "synthetic executable fixture");
    },
  });
  service.setRuntimeProject(source);
  try {
    const first = service.prepareRuntime();
    assert.equal(service.prepareRuntime(), first);
    while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await service.inspect()).runtime.preparing, true);
    release();
    const ready = await first;
    assert.equal(ready.runtime.prepared, true);
    assert.equal(ready.runtime.preparing, false);
    assert.notEqual(ready.runtime.projectDirectory, source);
    assert.equal(
      await readFile(
        path.join(ready.runtime.projectDirectory, "uv.lock"),
        "utf8",
      ),
      "fixture uv.lock",
    );
    await service.prepareRuntime();
    assert.equal(runs, 1);
    const failed = new ImZenXSetupService({
      directory: path.join(f.root, "failed"),
      encryption: f.encryption,
      runSetup: async () => {
        throw new Error(secret);
      },
    });
    failed.setRuntimeProject(source);
    const failure = await failed.prepareRuntime();
    assert.equal(failure.runtime.prepared, false);
    assert.match(failure.runtime.error!, /private IM Agent SDK/);
    assert.doesNotMatch(JSON.stringify(failure), new RegExp(secret));
  } finally {
    await f.close();
  }
});
