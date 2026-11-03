import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FileItemListStore } from "../src/item-list-store.js";
import { DomainThreadJournal } from "../src/domain-journal.js";
import type { CanonicalItem } from "../src/item.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { FileTraceStore } from "../src/trace.js";

const metadata: CanonicalItem = {
  id: "metadata",
  threadId: "t",
  createdAt: "2026-11-02T00:00:00.000Z",
  type: "thread_metadata",
  cwd: "/synthetic",
  provider: "fake",
  model: "fake",
  sandbox: "read-only",
  approvalPolicy: "always",
};
const user = (id: string): CanonicalItem => ({
  id,
  threadId: "t",
  turnId: "turn",
  createdAt: "2026-11-02T00:00:00.000Z",
  type: "user_message",
  text: `Synthetic input ${id}`,
});

test("existence probes do not read semantic history; actual journal reads remain", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zen-existence-"));
  const directory = path.join(root, "threads");
  const trace = new FileTraceStore(path.join(root, "trace"));
  const journal = new DomainThreadJournal({
    directory,
    trace,
    metadata: new InMemoryThreadMetadataStore(),
  });
  const filename = path.join(directory, "items", "t.jsonl");
  let reads = 0;
  let bytesRead = 0;
  const read = fs.readFile;
  try {
    await journal.create([metadata, user("initial")]);
    const size = (await fs.stat(filename)).size;
    const tracked = t.mock.method(
      fs,
      "readFile",
      async (...args: Parameters<typeof read>) => {
        const result = await read(...args);
        if (args[0] === filename) {
          reads++;
          bytesRead += Buffer.byteLength(result);
        }
        return result;
      },
    );
    syncBuiltinESMExports();
    try {
      const store = new FileItemListStore(path.dirname(filename));
      assert.equal(await store.exists("t"), true);
      assert.equal(await store.exists("missing"), false);
      assert.equal(reads, 0, "existence must not read content");
      await journal.reconcileCompilation("t");
      assert.equal(
        reads,
        1,
        "reconciliation still reads and validates the complete ItemList",
      );
      await journal.assertRecoverySafe("t");
      assert.equal(
        reads,
        2,
        "recovery must validate current history, not a cached existence proof",
      );
      const receipt = await journal.append(user("next"));
      assert.equal(receipt.at(-1)?.id, "next");
      assert.equal(
        reads,
        3,
        "append reuses its operation-local validated raw bytes for publication",
      );
      assert.equal(bytesRead, 3 * size);
      t.diagnostic(
        JSON.stringify({ reads, bytesRead, priorItemListBytes: size }),
      );
    } finally {
      tracked.mock.restore();
      syncBuiltinESMExports();
    }
    assert.deepEqual(await journal.read("t"), [
      metadata,
      user("initial"),
      user("next"),
    ]);
    const observed = await trace.read("t");
    await fs.appendFile(filename, "incomplete");
    await assert.rejects(
      journal.assertRecoverySafe("t"),
      /Incomplete semantic JSONL tail/,
    );
    await assert.rejects(
      journal.append(user("not-admitted")),
      /Incomplete semantic JSONL tail/,
    );
    assert.deepEqual(await trace.read("t"), observed);
  } finally {
    await journal.close();
    await trace.flush();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("existence distinguishes absent files from invalid identity, aliases and unreadable files", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "zen-existence-errors-"),
  );
  const directory = path.join(root, "items");
  const store = new FileItemListStore(directory);
  const filename = path.join(directory, "t.jsonl");
  try {
    assert.equal(
      await store.exists("t"),
      false,
      "absent parent is absent, not valid storage",
    );
    await assert.rejects(store.exists("../outside"), /Invalid Thread identity/);
    await store.create("t", []);
    assert.equal(await store.exists("t"), true, "empty ItemList exists");
    await fs.writeFile(filename, "not valid JSON\n");
    assert.equal(
      await store.exists("t"),
      true,
      "existence is not content validation",
    );
    await assert.rejects(store.read("t"));
    await fs.writeFile(filename, "incomplete");
    assert.equal(await store.exists("t"), true);
    await assert.rejects(store.read("t"), /Incomplete semantic JSONL tail/);

    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      await fs.chmod(filename, 0);
      try {
        await assert.rejects(store.exists("t"), { code: "EACCES" });
      } finally {
        await fs.chmod(filename, 0o600);
      }
      await fs.chmod(directory, 0);
      try {
        await assert.rejects(store.exists("t"), { code: "EACCES" });
      } finally {
        await fs.chmod(directory, 0o700);
      }
    } else {
      t.diagnostic(
        "POSIX unreadable-file/directory checks unavailable on this platform/user",
      );
    }

    await fs.unlink(filename);
    await fs.mkdir(filename);
    await assert.rejects(store.exists("t"), /unaliased regular file/);
    await fs.rmdir(filename);
    const target = path.join(root, "target.jsonl");
    await fs.writeFile(target, "");
    await fs.link(target, filename);
    await assert.rejects(store.exists("t"), /unaliased regular file/);
    await fs.unlink(filename);
    if (process.platform !== "win32") {
      await fs.symlink(target, filename);
      await assert.rejects(store.exists("t"), /unaliased regular file/);
      await fs.unlink(target);
      await assert.rejects(
        store.exists("t"),
        /unaliased regular file/,
        "dangling symlink is not absence",
      );
      await fs.unlink(filename);
    }
    assert.equal(await store.exists("t"), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("fresh probes reject a replaced leaf instead of retaining an existence cache", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "zen-existence-replaced-"),
  );
  const store = new FileItemListStore(root);
  const filename = path.join(root, "t.jsonl");
  const target = path.join(root, "other.jsonl");
  try {
    await store.create("t", []);
    assert.equal(await store.exists("t"), true);
    await fs.unlink(filename);
    assert.equal(await store.exists("t"), false);
    await fs.writeFile(target, "");
    await fs.link(target, filename);
    await assert.rejects(store.exists("t"), /unaliased regular file/);
    await fs.unlink(filename);
    if (process.platform !== "win32") {
      await fs.symlink(target, filename);
      await assert.rejects(store.exists("t"), /unaliased regular file/);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("journal ownership still rejects another writer and a retargeted source directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zen-existence-owner-"));
  const directory = path.join(root, "threads");
  const trace = new FileTraceStore(path.join(root, "trace"));
  const options = {
    directory,
    trace,
    metadata: new InMemoryThreadMetadataStore(),
  };
  const journal = new DomainThreadJournal(options);
  let other: DomainThreadJournal | undefined;
  try {
    await journal.create([metadata, user("initial")]);
    assert.throws(() => new DomainThreadJournal(options), /already owned/);
    if (process.platform !== "win32") {
      const otherDirectory = path.join(root, "other");
      const otherTrace = new FileTraceStore(path.join(root, "other-trace"));
      other = new DomainThreadJournal({
        ...options,
        directory: otherDirectory,
        trace: otherTrace,
      });
      await other.create([metadata, user("foreign")]);
      await fs.rename(directory, path.join(root, "parked"));
      await fs.symlink(otherDirectory, directory, "dir");
      await assert.rejects(
        journal.append(user("not-admitted")),
        /inode replaced/,
      );
      await assert.rejects(journal.reconcileCompilation("t"), /inode replaced/);
      assert.deepEqual(await other.read("t"), [metadata, user("foreign")]);
      await otherTrace.flush();
    }
  } finally {
    await journal.close();
    await other?.close();
    await trace.flush();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("opened non-files and probe I/O errors fail closed and release the descriptor", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zen-existence-open-"));
  const store = new FileItemListStore(root);
  const filename = path.join(root, "t.jsonl");
  const open = fs.open;
  let opened: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await store.create("t", []);
    const tracked = t.mock.method(
      fs,
      "open",
      async (...args: Parameters<typeof open>) => {
        const file = await open(...args);
        if (args[0] === filename) {
          opened = file;
          t.mock.method(file, "stat", async () => {
            throw Object.assign(new Error("Synthetic descriptor I/O failure"), {
              code: "EIO",
            });
          });
        }
        return file;
      },
    );
    syncBuiltinESMExports();
    try {
      await assert.rejects(store.exists("t"), { code: "EIO" });
      assert.equal(
        opened?.fd,
        -1,
        "failed probe must close its actual descriptor",
      );
    } finally {
      tracked.mock.restore();
      syncBuiltinESMExports();
    }
    if (process.platform !== "win32") {
      const replace = t.mock.method(
        fs,
        "open",
        async (...args: Parameters<typeof open>) => {
          if (args[0] === filename) {
            await fs.unlink(filename);
            await fs.mkdir(filename);
          }
          const file = await open(...args);
          if (args[0] === filename) opened = file;
          return file;
        },
      );
      syncBuiltinESMExports();
      try {
        await assert.rejects(store.exists("t"), /unaliased regular file/);
        assert.equal(opened?.fd, -1);
      } finally {
        replace.mock.restore();
        syncBuiltinESMExports();
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("one append snapshot repairs a missing compiled suffix before publishing new input", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zen-repair-snapshot-"));
  const directory = path.join(root, "threads");
  const trace = new FileTraceStore(path.join(root, "trace"));
  let publications = 0;
  const journal = new DomainThreadJournal({
    directory,
    trace,
    metadata: new InMemoryThreadMetadataStore(),
    onItemListAppendPhase(phase) {
      if (phase === "synced") publications++;
    },
  });
  const filename = path.join(directory, "items", "t.jsonl");
  const read = fs.readFile;
  try {
    await journal.create([metadata, user("retained"), user("repair")]);
    const original = await read(filename, "utf8");
    const prefix = " " + original.split("\n")[0] + "\r\n";
    await fs.writeFile(filename, prefix);
    let reads = 0;
    const tracked = t.mock.method(
      fs,
      "readFile",
      async (...args: Parameters<typeof read>) => {
        const bytes = await read(...args);
        if (args[0] === filename) reads++;
        return bytes;
      },
    );
    syncBuiltinESMExports();
    let receipt;
    try {
      receipt = await journal.append(user("next"));
      assert.equal(
        reads,
        1,
        "repair and new input share one validated prefix, not two public queued appends",
      );
      assert.equal(
        publications,
        2,
        "repair and new input retain their separate durable atomic publications",
      );
    } finally {
      tracked.mock.restore();
      syncBuiltinESMExports();
    }
    assert.deepEqual(
      receipt.map((i) => i.id),
      ["retained", "repair", "next"],
    );
    const durable = await read(filename, "utf8");
    assert.equal(durable.startsWith(prefix), true);
    assert.deepEqual(
      durable
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).id),
      ["retained", "repair", "next"],
    );
    await journal.close();
    const cold = new DomainThreadJournal({
      directory,
      trace,
      metadata: new InMemoryThreadMetadataStore(),
    });
    try {
      await cold.assertRecoverySafe("t");
      assert.deepEqual(
        (await cold.readItemList("t")).map((i) => i.id),
        ["retained", "repair", "next"],
      );
    } finally {
      await cold.close();
    }
  } finally {
    await journal.close();
    await trace.flush();
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const reader of ["read", "readSnapshot"] as const)
  for (const stage of ["before-read", "after-read"] as const)
    test(`append snapshot fails closed when its source disappears ${stage} (${reader})`, async (t) => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "zen-snapshot-missing-"),
      );
      const directory = path.join(root, "threads");
      const trace = new FileTraceStore(path.join(root, "trace"));
      const journal = new DomainThreadJournal({
        directory,
        trace:
          reader === "readSnapshot"
            ? trace
            : {
                record: trace.record.bind(trace),
                recordBatch: trace.recordBatch.bind(trace),
                read: (...args: Parameters<FileTraceStore["read"]>) =>
                  trace.read(...args),
                readArtifact: trace.readArtifact.bind(trace),
              },
        metadata: new InMemoryThreadMetadataStore(),
      });
      const filename = path.join(directory, "items", "t.jsonl");
      const read = fs.readFile;
      const readTrace = trace.read.bind(trace);
      const readSnapshot = trace.readSnapshot.bind(trace);
      let removed = false;
      try {
        await journal.create([metadata, user("initial")]);
        const before = await readTrace("t");
        const tracked = t.mock.method(
          fs,
          "readFile",
          async (...args: Parameters<typeof read>) => {
            const bytes = await read(...args);
            if (stage === "after-read" && args[0] === filename && !removed) {
              await fs.unlink(filename);
              removed = true;
            }
            return bytes;
          },
        );
        syncBuiltinESMExports();
        const removeBeforeSemanticRead = async () => {
          if (stage === "before-read" && !removed) {
            await fs.unlink(filename);
            removed = true;
          }
        };
        trace.read = async (...args) => {
          const observed = await readTrace(...args);
          await removeBeforeSemanticRead();
          return observed;
        };
        trace.readSnapshot = async (...args) => {
          const observed = await readSnapshot(...args);
          await removeBeforeSemanticRead();
          return observed;
        };
        try {
          await assert.rejects(journal.append(user("not-admitted")), {
            code: "ENOENT",
          });
          assert.equal(removed, true);
        } finally {
          tracked.mock.restore();
          syncBuiltinESMExports();
          trace.read = readTrace;
          trace.readSnapshot = readSnapshot;
        }
        await assert.rejects(fs.stat(filename), { code: "ENOENT" });
        assert.deepEqual(
          await readTrace("t"),
          before,
          "no new input source or semantic publication occurred",
        );
        // Explicit standalone recovery still rebuilds from fresh source evidence.
        await journal.reconcileCompilation("t");
        assert.deepEqual(
          (await journal.readItemList("t")).map((i) => i.id),
          ["initial"],
        );
      } finally {
        trace.read = readTrace;
        trace.readSnapshot = readSnapshot;
        await journal.close();
        await trace.flush();
        await fs.rm(root, { recursive: true, force: true });
      }
    });
