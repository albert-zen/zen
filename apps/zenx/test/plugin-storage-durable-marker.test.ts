import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { syncDirectory } from "../../../src/storage-files.js";
import {
  createZenXPluginHostSdk,
  JsonPluginStorage,
  type PluginStorageFileSystem,
} from "../src/main/plugin-host-sdk.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-marker-sync-"));
  const events: string[] = [];
  const faults = {
    short: false,
    zero: false,
    sync: false,
    directory: false,
    rename: 0,
  };
  const fs: PluginStorageFileSystem = {
    readFile,
    mkdir,
    writeFile,
    unlink: async (filename) => {
      events.push("unlink");
      await unlink(filename);
    },
    rename: async (source, target) => {
      events.push("rename");
      if (faults.rename > 0) {
        faults.rename--;
        throw Error("injected rename failure");
      }
      await rename(source, target);
    },
    openFile: (async (...args: Parameters<typeof open>) => {
      const file = await open(...args);
      return {
        write: async (
          bytes: Buffer,
          offset: number,
          length: number,
          position: null,
        ) => {
          events.push("write");
          if (faults.zero) return { bytesWritten: 0, buffer: bytes };
          return await file.write(
            bytes,
            offset,
            faults.short ? Math.min(3, length) : length,
            position,
          );
        },
        sync: async () => {
          events.push("file-sync");
          if (faults.sync) throw Error("injected sync failure");
          await file.sync();
        },
        close: async () => {
          events.push("close");
          await file.close();
        },
      } as Awaited<ReturnType<typeof open>>;
    }) as typeof open,
    syncDirectory: async (directory) => {
      events.push("directory-sync");
      if (faults.directory) throw Error("injected directory sync failure");
      await syncDirectory(directory);
    },
  };
  const options = {
    root,
    pluginId: "synthetic-marker",
    version: 1,
    fileSystem: fs,
    syncWrites: true,
    bindGeneration: true,
  };
  const filename = path.join(root, options.pluginId, "storage.json");
  const migrate = [
    {
      fromVersion: 1,
      toVersion: 2,
      migrate: async () => ({ format: "synthetic-v2" }),
    },
  ];
  return {
    root,
    fs,
    faults,
    events,
    options,
    filename,
    migrate,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("opt-in writes complete short UTF-8 writes, sync file before rename and directory before success", async () => {
  const f = await fixture();
  try {
    f.faults.short = true;
    const store = await JsonPluginStorage.open({
      ...f.options,
      initialValue: { text: "合成🙂" },
    });
    assert.deepEqual(await store.get(), { text: "合成🙂" });
    assert(f.events.filter((event) => event === "write").length > 1);
    assert.deepEqual(f.events.slice(-5), [
      "file-sync",
      "close",
      "rename",
      "directory-sync",
      "unlink",
    ]);
    f.events.length = 0;
    await store.set({ text: "next" });
    assert.deepEqual(JSON.parse(await readFile(f.filename, "utf8")).value, {
      text: "next",
    });
    assert.deepEqual(f.events.slice(-5), [
      "file-sync",
      "close",
      "rename",
      "directory-sync",
      "unlink",
    ]);
  } finally {
    await f.cleanup();
  }
});

test("default storage accepts old IO seam; opt-in missing sync primitives rejects before writing", async () => {
  const f = await fixture();
  try {
    const { openFile: _open, syncDirectory: _sync, ...legacyFs } = f.fs;
    const legacy = await JsonPluginStorage.open({
      ...f.options,
      fileSystem: legacyFs,
      syncWrites: false,
    });
    await legacy.set({ legacy: true });
    const before = await readFile(f.filename, "utf8");
    await assert.rejects(
      JsonPluginStorage.prepare({ ...f.options, fileSystem: legacyFs }),
      /requires openFile and syncDirectory/,
    );
    assert.equal(await readFile(f.filename, "utf8"), before);
    assert.equal(f.events.includes("file-sync"), false);
  } finally {
    await f.cleanup();
  }
});

test("synced prepare fences old handle and rollback restores exact source bytes", async () => {
  const f = await fixture();
  try {
    await mkdir(path.dirname(f.filename), { recursive: true });
    const raw = ' {"value":{"text":"原始"}, "version":1}\n\n';
    await writeFile(f.filename, raw);
    const old = await JsonPluginStorage.open(f.options);
    const candidate = await JsonPluginStorage.prepare({
      ...f.options,
      version: 2,
      migrations: f.migrate,
    });
    await assert.rejects(old.get(), /replacement is being prepared/);
    assert.deepEqual(await candidate.storage.get(), { format: "synthetic-v2" });
    f.events.length = 0;
    await candidate.rollback();
    assert.equal(await readFile(f.filename, "utf8"), raw);
    assert.deepEqual(await old.get(), { text: "原始" });
    assert.deepEqual(f.events.slice(-5), [
      "file-sync",
      "close",
      "rename",
      "directory-sync",
      "unlink",
    ]);
  } finally {
    await f.cleanup();
  }
});

test("published candidate remains generation-bound and readonly SDK cannot alter its marker", async () => {
  const f = await fixture();
  try {
    const old = await JsonPluginStorage.open(f.options);
    const candidate = await JsonPluginStorage.prepare({
      ...f.options,
      version: 2,
      migrations: f.migrate,
    });
    await candidate.storage.set({ format: "staged" });
    candidate.publish();
    await assert.rejects(old.get(), /generation was replaced/);
    const sdk = await createZenXPluginHostSdk({
      pluginId: f.options.pluginId,
      storageRoot: f.root,
      storageVersion: 2,
      storage: candidate.storage,
      storageReadOnly: true,
      queryProjects: async () => [],
      appServer: {
        completeTurn: async () => {
          throw Error("no dispatch");
        },
      },
    });
    assert.deepEqual(await sdk.storage.get(), { format: "staged" });
    const before = await readFile(f.filename, "utf8");
    await assert.rejects(sdk.storage.set({ arbitrary: true }), /read-only/);
    assert.equal(await readFile(f.filename, "utf8"), before);
  } finally {
    await f.cleanup();
  }
});

for (const fault of ["sync", "zero"] as const) {
  test(`${fault} before publication never changes authoritative bytes or cached state`, async () => {
    const f = await fixture();
    try {
      const store = await JsonPluginStorage.open({
        ...f.options,
        initialValue: { old: true },
      });
      const before = await readFile(f.filename, "utf8");
      f.events.length = 0;
      f.faults[fault] = true;
      await assert.rejects(
        store.set({ next: true }),
        fault === "sync" ? /injected sync failure/ : /no progress/,
      );
      assert.equal(f.events.includes("rename"), false);
      assert.equal(await readFile(f.filename, "utf8"), before);
      assert.deepEqual(await store.get(), { old: true });
    } finally {
      await f.cleanup();
    }
  });
}

test("post-rename sync failure never ACKs visible bytes and fences every live handle", async () => {
  const f = await fixture();
  try {
    const store = await JsonPluginStorage.open(f.options);
    const peer = await JsonPluginStorage.open(f.options);
    f.faults.directory = true;
    await assert.rejects(store.set({ visible: true }), /outcome is unknown/);
    assert.deepEqual(JSON.parse(await readFile(f.filename, "utf8")).value, {
      visible: true,
    });
    await assert.rejects(store.get(), /outcome is unknown/);
    await assert.rejects(
      peer.set({ mustNotWrite: true }),
      /outcome is unknown/,
    );
    await assert.rejects(
      JsonPluginStorage.open(f.options),
      /outcome is unknown/,
    );
  } finally {
    await f.cleanup();
  }
});

test("failed prepare may recover only through successful synced exact-byte rollback", async () => {
  const f = await fixture();
  try {
    const old = await JsonPluginStorage.open({
      ...f.options,
      initialValue: { old: true },
    });
    const before = await readFile(f.filename, "utf8");
    f.faults.rename = 1;
    await assert.rejects(
      JsonPluginStorage.prepare({
        ...f.options,
        version: 2,
        migrations: f.migrate,
      }),
      /outcome is unknown/,
    );
    assert.equal(await readFile(f.filename, "utf8"), before);
    assert.deepEqual(await old.get(), { old: true });
    assert.equal(old.replacementPending, false);
  } finally {
    await f.cleanup();
  }
});

test("failed prepare and failed rollback retain replacement fence rather than old-cache ACK", async () => {
  const f = await fixture();
  try {
    const old = await JsonPluginStorage.open(f.options);
    f.faults.rename = 2;
    await assert.rejects(
      JsonPluginStorage.prepare({
        ...f.options,
        version: 2,
        migrations: f.migrate,
      }),
      /rollback failed.*fenced/,
    );
    assert.equal(old.replacementPending, true);
    await assert.rejects(old.get(), /replacement is being prepared/);
    await assert.rejects(
      old.set({ no: true }),
      /replacement is being prepared/,
    );
  } finally {
    await f.cleanup();
  }
});

test("rollback of newly created marker syncs removal before clearing its fence", async () => {
  const f = await fixture();
  try {
    const candidate = await JsonPluginStorage.prepare(f.options);
    f.events.length = 0;
    await candidate.rollback();
    assert.deepEqual(f.events, ["unlink", "directory-sync"]);
    await assert.rejects(readFile(f.filename), { code: "ENOENT" });
    assert.equal(candidate.storage.replacementPending, false);
  } finally {
    await f.cleanup();
  }
});

test("unknown candidate set cannot publish; only completed rollback restores the old owner", async () => {
  const f = await fixture();
  try {
    const old = await JsonPluginStorage.open({
      ...f.options,
      initialValue: { original: true },
    });
    const before = await readFile(f.filename, "utf8");
    const candidate = await JsonPluginStorage.prepare({
      ...f.options,
      version: 2,
      migrations: f.migrate,
    });
    f.faults.directory = true;
    await assert.rejects(
      candidate.storage.set({ uncertain: true }),
      /outcome is unknown/,
    );
    assert.throws(() => candidate.publish(), /outcome is unknown/);
    assert.equal(old.replacementPending, true);
    await assert.rejects(old.get(), /outcome is unknown/);
    f.faults.directory = false;
    await candidate.rollback();
    assert.equal(await readFile(f.filename, "utf8"), before);
    assert.deepEqual(await old.get(), { original: true });
    assert.equal(old.replacementPending, false);
  } finally {
    await f.cleanup();
  }
});

test("native opt-in primitive creates and updates a marker without changing ordinary quota", async () => {
  const f = await fixture();
  try {
    const store = await JsonPluginStorage.open({
      ...f.options,
      fileSystem: undefined,
    });
    await store.set({ marker: "native" });
    assert.deepEqual(await store.get(), { marker: "native" });
    await assert.rejects(
      store.set({ tooLarge: "x".repeat(1024 * 1024) }),
      /byte limit/,
    );
    assert.deepEqual(await store.get(), { marker: "native" });
  } finally {
    await f.cleanup();
  }
});
