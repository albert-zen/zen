import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  truncate,
  writeFile,
  appendFile,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { syncDirectory } from "../../../src/storage-files.js";
import {
  AutomationTransactionStore,
  fingerprintOperationBody,
  type AutomationMetadata,
  type AutomationOperationBodyRef,
  type AutomationRoomEvent,
  type AutomationTransactionOptions,
} from "../src/main/automation-transaction-store.js";
import { MAX_ROOM_OPERATIONS } from "../src/main/trigger-limits.js";
import { canonicalTriggerSnapshot } from "../src/main/trigger-store.js";
import type { RoomMessage } from "../src/main/trigger-types.js";

// Freshly rebuilt synthetic regressions, not recovered test-result evidence.
const metadata = (messageCount = 0): AutomationMetadata => ({
  triggers: [],
  history: [],
  rooms: [
    {
      id: "room",
      name: "Synthetic",
      members: [{ name: "Bot", threadId: "thread" }],
      createdAt: 0,
      messageCount,
    },
  ],
});
const message = (id: number, text = `Synthetic ${id}`): RoomMessage => ({
  id: `m${id}`,
  roomId: "room",
  kind: "agent",
  author: "Bot",
  text,
  createdAt: id % 3,
  originThreadId: "thread",
  originTurnId: `turn-${id}`,
});
const event = (id: number, text?: string): AutomationRoomEvent => ({
  type: "message",
  message: message(id, text),
});
const reaction: AutomationRoomEvent = {
  type: "reaction",
  roomId: "room",
  messageId: "m0",
  reactions: [{ actorId: "human", label: "You", emoji: "👀" }],
};
interface Probe {
  reads: number;
  readBytes: number;
  writes: number;
  writeBytes: number;
  readLimit?: number;
  writeLimit?: number;
  zeroRead?: boolean;
  zeroWrite?: boolean;
  failWrite?: boolean;
  failWriteAfter?: number;
  failSync?: boolean;
  failDirectorySync?: boolean;
  beforeRead?: () => Promise<void>;
  afterSync?: () => Promise<void>;
}
interface Fixture {
  options: AutomationTransactionOptions;
  probe: Probe;
  directory: string;
  keep(store: AutomationTransactionStore): AutomationTransactionStore;
  file(store: AutomationTransactionStore): string;
}
async function fixture(run: (f: Fixture) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-rebuilt-core-"));
  const stores: AutomationTransactionStore[] = [];
  const probe: Probe = { reads: 0, readBytes: 0, writes: 0, writeBytes: 0 };
  const options: AutomationTransactionOptions = {
    directory,
    assertWriterLease() {},
    syncDirectory: async (dir) => {
      if (probe.failDirectorySync) throw Error("injected directory sync");
      await syncDirectory(dir);
    },
    openFile: (async (...args: Parameters<typeof open>) => {
      const file = await open(...args);
      return new Proxy(file, {
        get(target, key) {
          if (key === "read")
            return async (
              buffer: Buffer,
              offset: number,
              length: number,
              position: number,
            ) => {
              probe.reads++;
              await probe.beforeRead?.();
              if (probe.zeroRead) return { bytesRead: 0, buffer };
              const result = await target.read(
                buffer,
                offset,
                Math.min(length, probe.readLimit ?? length),
                position,
              );
              probe.readBytes += result.bytesRead;
              return result;
            };
          if (key === "write")
            return async (
              buffer: Buffer,
              offset: number,
              length: number,
              position: number | null,
            ) => {
              probe.writes++;
              if (
                probe.failWrite ||
                (probe.failWriteAfter !== undefined &&
                  probe.writes > probe.failWriteAfter)
              )
                throw Error("injected write");
              if (probe.zeroWrite) return { bytesWritten: 0, buffer };
              const result = await target.write(
                buffer,
                offset,
                Math.min(length, probe.writeLimit ?? length),
                position,
              );
              probe.writeBytes += result.bytesWritten;
              return result;
            };
          if (key === "sync")
            return async () => {
              if (probe.failSync) throw Error("injected file sync");
              await target.sync();
              await probe.afterSync?.();
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof open,
  };
  try {
    await run({
      directory,
      options,
      probe,
      keep(store) {
        stores.push(store);
        return store;
      },
      file: (store) =>
        path.join(directory, `automation-${store.generation}.jsonl`),
    });
  } finally {
    for (const store of stores) await store.close();
    await rm(directory, { recursive: true, force: true });
  }
}
const check = (name: string, run: (f: Fixture) => Promise<void>) =>
  test(name, { timeout: 30_000 }, () => fixture(run));

check(
  "more than 256 messages and 1 MiB persist in order; append reads no history and pages are bounded",
  async ({ options, probe, keep, file }) => {
    let store = keep(
      await AutomationTransactionStore.create(options, metadata()),
    );
    for (let i = 0; i < 320; i++)
      await store.append({
        metadata: metadata(i + 1),
        roomEvents: [event(i, `${i}:` + "x".repeat(5000))],
      });
    assert.equal(probe.reads, 0);
    assert((await stat(file(store))).size > 1024 * 1024);
    const generation = store.generation;
    await store.close();
    store = keep(await AutomationTransactionStore.open(options, generation));
    let cursor: number | null = 0;
    const ids: string[] = [];
    do {
      probe.readBytes = 0;
      const page = await store.readRoomPage("room", cursor);
      assert(page.messages.length <= 4);
      assert(probe.readBytes < 100_000);
      ids.unshift(...page.messages.map((m) => m.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    assert.deepEqual(
      ids,
      Array.from({ length: 320 }, (_, i) => `m${i}`),
    );
    assert.equal(new Set(ids).size, 320);
    const before = probe.reads;
    const receipt = await store.append({
      metadata: metadata(321),
      roomEvents: [event(320)],
    });
    assert.equal(probe.reads, before);
    assert.equal(
      receipt.sync,
      process.platform === "win32" ? "file" : "file-and-directory",
    );
  },
);
check(
  "same-frame page caches transaction once and quote copying survives missing source",
  async ({ options, probe, keep }) => {
    const store = keep(
      await AutomationTransactionStore.create(options, metadata()),
    );
    const quoted = message(0);
    quoted.replyTo = {
      messageId: "legacy-absent",
      author: "You",
      text: "retained quote",
    };
    await store.append({
      metadata: metadata(4),
      roomEvents: [
        { type: "message", message: quoted },
        event(1),
        event(2),
        event(3),
      ],
    });
    probe.reads = 0;
    const page = await store.readRoomPage("room");
    assert.equal(probe.reads, 1);
    assert.deepEqual(page.messages[0]!.replyTo, quoted.replyTo);
  },
);
check(
  "pinned snapshots validate exact boundary and retain pre-update reactions",
  async ({ options, keep }) => {
    const store = keep(
      await AutomationTransactionStore.create(options, metadata()),
    );
    await store.append({ metadata: metadata(1), roomEvents: [event(0)] });
    const pinned = store.roomSnapshot("room");
    await store.append({
      metadata: metadata(2),
      roomEvents: [event(1), reaction],
    });
    assert.equal(
      (await store.readRoomMessage("room", "m0", pinned))!.message.reactions,
      undefined,
    );
    assert.deepEqual(
      (await store.readRoomMessage("room", "m0"))!.message.reactions,
      reaction.reactions,
    );
    for (const changed of [
      { messageCount: 2 },
      { generation: "other" },
      { roomId: "other" },
      { hash: "a".repeat(64) },
      { revision: 999 },
    ])
      await assert.rejects(
        store.readRoomPage("room", 0, { ...pinned, ...changed }),
        /snapshot|boundary|identity/i,
      );
    await assert.rejects(store.readRoomPage("room", 3), /cursor/);
  },
);
check(
  "duplicate messages, missing reaction targets, wrong counts and removed-room reuse reject before I/O",
  async ({ options, keep, probe }) => {
    const store = keep(
      await AutomationTransactionStore.create(options, metadata()),
    );
    await store.append({ metadata: metadata(1), roomEvents: [event(0)] });
    const writes = probe.writes;
    for (const candidate of [
      { metadata: metadata(2), roomEvents: [event(0)] },
      {
        metadata: metadata(1),
        roomEvents: [{ ...reaction, messageId: "missing" }],
      },
      { metadata: metadata(2), roomEvents: [] },
    ])
      await assert.rejects(store.append(candidate), /Duplicate|missing|count/);
    assert.equal(probe.writes, writes);
    await store.append({
      metadata: { triggers: [], history: [], rooms: [] },
      roomEvents: [],
    });
    await assert.rejects(
      store.append({ metadata: metadata(1), roomEvents: [] }),
      /cannot be reused/,
    );
  },
);
check(
  "body-free metadata still has its independent bounded quota",
  async ({ options, keep, probe }) => {
    const store = keep(
      await AutomationTransactionStore.create(options, metadata()),
    );
    const large = metadata();
    large.rooms[0]!.name = "x".repeat(1024 * 1024);
    const writes = probe.writes;
    await assert.rejects(
      store.append({ metadata: large, roomEvents: [] }),
      /byte limit/,
    );
    assert.equal(probe.writes, writes);
    await store.append({ metadata: metadata(), roomEvents: [] });
  },
);
for (const fault of ["failSync", "failDirectorySync"] as const)
  check(
    `${fault}: complete fact is unknown, fences reads/writes, reopens without success receipt`,
    async ({ options, keep, probe }) => {
      let store = keep(
        await AutomationTransactionStore.create(options, metadata()),
      );
      probe[fault] = true;
      await assert.rejects(
        store.append({ metadata: metadata(1), roomEvents: [event(0)] }),
        /unknown/,
      );
      assert.throws(() => store.metadata(), /unknown/);
      assert.throws(() => store.position, /unknown/);
      await assert.rejects(
        store.append({ metadata: metadata(), roomEvents: [] }),
        /unknown/,
      );
      probe[fault] = false;
      const generation = store.generation;
      await store.close();
      store = keep(await AutomationTransactionStore.open(options, generation));
      assert.equal(store.metadata().rooms[0]!.messageCount, 1);
      assert.equal("sync" in store.position, false);
    },
  );
for (const fault of ["zeroWrite", "failWrite"] as const)
  check(
    `${fault}: no ACK, no new bytes, reopen old complete facts`,
    async ({ options, keep, probe, file }) => {
      let store = keep(
        await AutomationTransactionStore.create(options, metadata()),
      );
      const bytes = await readFile(file(store));
      probe[fault] = true;
      await assert.rejects(
        store.append({ metadata: metadata(1), roomEvents: [event(0)] }),
        /unknown/,
      );
      assert.deepEqual(await readFile(file(store)), bytes);
      probe[fault] = false;
      const generation = store.generation;
      await store.close();
      store = keep(await AutomationTransactionStore.open(options, generation));
      assert.equal(store.metadata().rooms[0]!.messageCount, 0);
    },
  );
check(
  "partial write stays fenced and partial tail is never truncated or replayed",
  async ({ options, keep, probe, file }) => {
    const store = keep(
      await AutomationTransactionStore.create(options, metadata()),
    );
    probe.writeLimit = 10;
    probe.failWriteAfter = probe.writes + 1;
    await assert.rejects(
      store.append({ metadata: metadata(1), roomEvents: [event(0)] }),
      /unknown/,
    );
    const bytes = await readFile(file(store));
    await store.close();
    probe.failWriteAfter = undefined;
    await assert.rejects(
      AutomationTransactionStore.open(options, store.generation),
      /partial/,
    );
    assert.deepEqual(await readFile(file(store)), bytes);
  },
);
check(
  "short read/write loops progress and zero reads fail explicitly",
  async ({ options, keep, probe }) => {
    probe.writeLimit = 7;
    let store = keep(
      await AutomationTransactionStore.create(options, metadata()),
    );
    await store.append({
      metadata: metadata(2),
      roomEvents: [event(0), event(1)],
    });
    const generation = store.generation;
    await store.close();
    probe.readLimit = 5;
    store = keep(await AutomationTransactionStore.open(options, generation));
    assert.deepEqual(
      (await store.readRoomPage("room")).messages.map((m) => m.id),
      ["m0", "m1"],
    );
    probe.zeroRead = true;
    await assert.rejects(store.readRoomMessage("room", "m0"), /truncated/);
    await assert.rejects(
      AutomationTransactionStore.open(options, generation),
      /truncated/,
    );
  },
);
for (const damage of ["truncate", "tamper"] as const)
  check(
    `${damage} committed bytes: live indexed reads and reopen reject`,
    async ({ options, keep, file }) => {
      const store = keep(
        await AutomationTransactionStore.create(options, metadata()),
      );
      await store.append({ metadata: metadata(1), roomEvents: [event(0)] });
      const filename = file(store);
      const bytes = await readFile(filename);
      if (damage === "truncate") await truncate(filename, bytes.length - 3);
      else {
        bytes[bytes.indexOf("Synthetic 0")] = 88;
        await writeFile(filename, bytes);
      }
      await assert.rejects(
        store.readRoomMessage("room", "m0"),
        /truncated|checksum|hash|invalid/,
      );
      await assert.rejects(
        AutomationTransactionStore.open(options, store.generation),
        /partial|checksum|hash|invalid/,
      );
    },
  );
check(
  "checksummed chain with wrong revision is rejected on recovery",
  async ({ options, keep, file }) => {
    const store = keep(
      await AutomationTransactionStore.create(options, metadata()),
    );
    await store.close();
    const frame = JSON.parse(await readFile(file(store), "utf8"));
    frame.record.revision = 4;
    frame.sha256 = createHash("sha256")
      .update(JSON.stringify(frame.record))
      .digest("hex");
    await writeFile(file(store), JSON.stringify(frame) + "\n");
    await assert.rejects(
      AutomationTransactionStore.open(options, store.generation),
      /chain/,
    );
  },
);
check(
  "lease lost after file sync becomes unknown",
  async ({ options, keep, probe }) => {
    let permitted = true;
    const store = keep(
      await AutomationTransactionStore.create(
        {
          ...options,
          assertWriterLease() {
            if (!permitted) throw Error("lost lease");
          },
        },
        metadata(),
      ),
    );
    probe.afterSync = async () => {
      permitted = false;
    };
    await assert.rejects(
      store.append({ metadata: metadata(1), roomEvents: [event(0)] }),
      /unknown/,
    );
    assert.throws(() => store.position, /unknown/);
  },
);
check(
  "unexpected complete suffix fences existing writer",
  async ({ options, keep, file }) => {
    const store = keep(
      await AutomationTransactionStore.create(options, metadata()),
    );
    await appendFile(file(store), await readFile(file(store)));
    await assert.rejects(
      store.append({ metadata: metadata(), roomEvents: [] }),
      /unknown/,
    );
  },
);
async function replace(filename: string) {
  const bytes = await readFile(filename);
  await rename(filename, filename + ".detached");
  await writeFile(filename, bytes, { mode: 0o600 });
  return bytes;
}
for (const timing of ["beforeAppend", "duringSync", "beforeRead"] as const)
  check(
    `named-file replacement ${timing} never acknowledges or serves orphan descriptor`,
    async ({ options, keep, probe, file }) => {
      const store = keep(
        await AutomationTransactionStore.create(options, metadata()),
      );
      await store.append({ metadata: metadata(1), roomEvents: [event(0)] });
      const filename = file(store);
      if (timing === "duringSync")
        probe.afterSync = async () => {
          probe.afterSync = undefined;
          await replace(filename);
        };
      else await replace(filename);
      if (timing === "beforeRead")
        await assert.rejects(
          store.readRoomMessage("room", "m0"),
          /identity|changed/,
        );
      else
        await assert.rejects(
          store.append({ metadata: metadata(2), roomEvents: [event(1)] }),
          /unknown/,
        );
    },
  );
async function deadline<T>(pending: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error(`Timed out: ${label}`)), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function pauseRead(probe: Probe) {
  let entered!: () => void, resume!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const beforeRead = async () => {
    probe.beforeRead = undefined;
    entered();
    await deadline(resumed, "read release");
  };
  probe.beforeRead = beforeRead;
  return {
    entered: () => deadline(started, "read entry"),
    release() {
      if (probe.beforeRead === beforeRead) probe.beforeRead = undefined;
      resume();
    },
  };
}
for (const method of ["message", "page"] as const)
  check(
    `caller snapshot mutation cannot upgrade paused ${method} read`,
    async ({ options, keep, probe }) => {
      const store = keep(
        await AutomationTransactionStore.create(options, metadata()),
      );
      await store.append({ metadata: metadata(1), roomEvents: [event(0)] });
      const pinned = store.roomSnapshot("room"),
        original = structuredClone(pinned);
      await store.append({ metadata: metadata(1), roomEvents: [reaction] });
      const pause = pauseRead(probe);
      const pending =
        method === "message"
          ? store.readRoomMessage("room", "m0", pinned)
          : store.readRoomPage("room", 0, pinned);
      const settled = pending.then(
        () => {},
        () => {},
      );
      try {
        await pause.entered();
        Object.assign(pinned, store.roomSnapshot("room"));
        pause.release();
        const result = await deadline<Awaited<typeof pending>>(
          pending,
          "snapshot result",
        );
        assert(result);
        assert.deepEqual(result.snapshot, original);
        assert.equal(
          ("message" in result ? result.message : result.messages[0]!)
            .reactions,
          undefined,
        );
      } finally {
        pause.release();
        await deadline(settled, "snapshot cleanup");
      }
    },
  );
check(
  "pending read cannot publish cached data after concurrent append becomes unknown",
  async ({ options, keep, probe }) => {
    const store = keep(
      await AutomationTransactionStore.create(options, metadata()),
    );
    await store.append({ metadata: metadata(1), roomEvents: [event(0)] });
    const pause = pauseRead(probe);
    const pending = store.readRoomMessage("room", "m0");
    const settled = pending.then(
      () => {},
      () => {},
    );
    try {
      await pause.entered();
      probe.failSync = true;
      await assert.rejects(
        store.append({ metadata: metadata(2), roomEvents: [event(1)] }),
        /unknown/,
      );
      pause.release();
      await assert.rejects(deadline(pending, "unknown result"), /unknown/);
    } finally {
      pause.release();
      await deadline(settled, "unknown cleanup");
    }
  },
);

const body = {
  type: "operationBody" as const,
  roomId: "room",
  operationId: "op",
  text: "x".repeat(8000),
};
const ref: AutomationOperationBodyRef = {
  kind: "operation",
  id: "op",
  sha256: fingerprintOperationBody(body),
};
function withOperation(
  bodyRef = ref,
  count = 0,
  messageId: string | null = null,
): AutomationMetadata {
  const value = metadata(count);
  value.rooms[0]!.operations = [
    {
      id: "op",
      bodyRef,
      messageId,
      createdAt: 0,
      acknowledged: false,
      mentions: [],
    },
  ];
  return value;
}
check(
  "operation bodies are lazy, metadata stays body-free, duplicate facts and evicted rebindings reject",
  async ({ options, keep, probe }) => {
    let store = keep(
      await AutomationTransactionStore.create(options, metadata()),
    );
    await store.append({ metadata: withOperation(), roomEvents: [body] });
    assert(JSON.stringify(store.metadata()).length < 1000);
    assert.deepEqual(await store.readOperationBody("room", ref), {
      text: body.text,
    });
    await assert.rejects(
      store.append({ metadata: withOperation(), roomEvents: [body] }),
      /Duplicate immutable/,
    );
    await store.append({ metadata: metadata(), roomEvents: [] });
    await assert.rejects(
      store.append({
        metadata: withOperation({ ...ref, sha256: "a".repeat(64) }),
        roomEvents: [],
      }),
      /Immutable/,
    );
    const generation = store.generation;
    await store.close();
    store = keep(await AutomationTransactionStore.open(options, generation));
    probe.reads = 0;
    assert.deepEqual(await store.readOperationBody("room", ref), {
      text: body.text,
    });
    assert(probe.reads > 0);
    await assert.rejects(
      store.readOperationBody("room", { ...ref, id: "missing" }),
      /missing/,
    );
  },
);
check(
  "prepared operation commits same-frame human message with same hash but cannot rebind target after eviction",
  async ({ options, keep }) => {
    const store = keep(
      await AutomationTransactionStore.create(options, metadata()),
    );
    await store.append({ metadata: withOperation(), roomEvents: [body] });
    const human = { ...message(0, body.text), kind: "human" as const };
    const messageRef: AutomationOperationBodyRef = {
      ...ref,
      kind: "message",
      id: human.id,
    };
    await store.append({
      metadata: withOperation(messageRef, 1, human.id),
      roomEvents: [{ type: "message", message: human }],
    });
    assert.deepEqual(
      await store.readOperationBody("room", messageRef),
      await store.readOperationBody("room", ref),
    );
    await store.append({ metadata: metadata(1), roomEvents: [] });
    const other = { ...human, id: "m1" };
    await assert.rejects(
      store.append({
        metadata: withOperation({ ...messageRef, id: other.id }, 2, other.id),
        roomEvents: [{ type: "message", message: other }],
      }),
      /Immutable operation binding/,
    );
  },
);
check(
  "missing/future/wrong-hash/foreign refs reject before writes",
  async ({ options, keep, probe }) => {
    const store = keep(
      await AutomationTransactionStore.create(options, metadata()),
    );
    const writes = probe.writes;
    for (const invalid of [
      ref,
      { ...ref, id: "other" },
      { ...ref, kind: "message" as const, id: "m0" },
    ])
      await assert.rejects(
        store.append({ metadata: withOperation(invalid), roomEvents: [] }),
        /reference/,
      );
    await assert.rejects(
      store.append({
        metadata: withOperation({ ...ref, sha256: "b".repeat(64) }),
        roomEvents: [body],
      }),
      /Immutable operation body/,
    );
    const otherRoom = { ...metadata().rooms[0]!, id: "other" };
    const values = withOperation();
    values.rooms.push(otherRoom);
    await assert.rejects(
      store.append({
        metadata: values,
        roomEvents: [{ ...body, roomId: "other" }],
      }),
      /reference/,
    );
    assert.equal(probe.writes, writes);
  },
);
check(
  "MAX_ROOM_OPERATIONS large escaped receipt bodies exceed 1 MiB while bounded metadata reloads",
  async ({ options, keep, file }) => {
    let store = keep(
      await AutomationTransactionStore.create(options, metadata()),
    );
    const value = metadata();
    value.rooms[0]!.operations = [];
    let bodyBytes = 0;
    for (let i = 0; i < MAX_ROOM_OPERATIONS; i++) {
      const fact = {
        ...body,
        operationId: `op-${i}`,
        text: "\\".repeat(8000),
        replyTo: { messageId: "old", author: "You", text: "\\".repeat(1000) },
      };
      bodyBytes += Buffer.byteLength(JSON.stringify(fact));
      value.rooms[0]!.operations.push({
        id: fact.operationId,
        bodyRef: {
          kind: "operation",
          id: fact.operationId,
          sha256: fingerprintOperationBody(fact),
        },
        messageId: null,
        createdAt: i,
        acknowledged: false,
        mentions: [],
      });
      await store.append({ metadata: value, roomEvents: [fact] });
    }
    assert(bodyBytes > 1024 * 1024);
    assert((await stat(file(store))).size > 1024 * 1024);
    assert(
      Buffer.byteLength(JSON.stringify(store.metadata())) <
        MAX_ROOM_OPERATIONS * 500,
    );
    const generation = store.generation;
    await store.close();
    store = keep(await AutomationTransactionStore.open(options, generation));
    assert.equal(
      store.metadata().rooms[0]!.operations!.length,
      MAX_ROOM_OPERATIONS,
    );
    assert.equal(
      (
        await store.readOperationBody(
          "room",
          value.rooms[0]!.operations!.at(-1)!.bodyRef,
        )
      ).text.length,
      8000,
    );
  },
);
for (const target of ["missing", "agent", "different-human"] as const)
  check(
    `legacy ${target} committed receipt imports original body; equivalent normal write rejects`,
    async ({ options, keep }) => {
      let store = keep(
        await AutomationTransactionStore.create(
          { ...options, allowLegacyReceiptImport: true },
          metadata(),
        ),
      );
      const targetMessage = {
        ...message(0, target === "different-human" ? "different" : body.text),
        kind:
          target === "different-human"
            ? ("human" as const)
            : ("agent" as const),
      };
      const count = target === "missing" ? 0 : 1;
      const events: AutomationRoomEvent[] = count
        ? [{ type: "message", message: targetMessage }]
        : [];
      const next = withOperation(ref, count, "m0");
      await assert.rejects(
        store.append({ metadata: next, roomEvents: [...events, body] }),
        /Committed operation message body/,
      );
      await store.append({
        metadata: next,
        roomEvents: [...events, { ...body, origin: "legacy-receipt" }],
      });
      const generation = store.generation;
      await store.close();
      store = keep(
        await AutomationTransactionStore.open(
          { ...options, allowLegacyReceiptImport: true },
          generation,
        ),
      );
      assert.deepEqual(await store.readOperationBody("room", ref), {
        text: body.text,
      });
      await store.append({ metadata: next, roomEvents: [] });
      await assert.rejects(
        store.append({
          metadata: next,
          roomEvents: [
            { ...body, operationId: "new", origin: "legacy-receipt" },
          ],
        }),
        /Invalid Room transaction event/,
      );
      const rebound = structuredClone(next);
      rebound.rooms[0]!.operations![0]!.messageId = "m1";
      await assert.rejects(
        store.append({ metadata: rebound, roomEvents: [] }),
        /Immutable operation binding/,
      );
    },
  );
check(
  "normal writer cannot manufacture legacy-origin exception",
  async ({ options, keep }) => {
    const store = keep(
      await AutomationTransactionStore.create(options, metadata()),
    );
    await assert.rejects(
      store.append({
        metadata: withOperation(ref, 0, "missing"),
        roomEvents: [{ ...body, origin: "legacy-receipt" }],
      }),
      /Invalid Room transaction event/,
    );
    await store.append({ metadata: withOperation(), roomEvents: [body] });
  },
);
check(
  "legacy unbound/prepared-null staging is forbidden; ordinary prepared import later commits strictly",
  async ({ options, keep }) => {
    let store = keep(
      await AutomationTransactionStore.create(
        { ...options, allowLegacyReceiptImport: true },
        metadata(),
      ),
    );
    const legacy = { ...body, origin: "legacy-receipt" as const };
    for (const value of [metadata(), withOperation()])
      await assert.rejects(
        store.append({ metadata: value, roomEvents: [legacy] }),
        /requires its bound committed operation/,
      );
    await store.append({ metadata: withOperation(), roomEvents: [body] });
    const generation = store.generation;
    await store.close();
    store = keep(await AutomationTransactionStore.open(options, generation));
    await assert.rejects(
      store.append({
        metadata: withOperation(ref, 0, "nonexistent"),
        roomEvents: [],
      }),
      /Committed operation message body/,
    );
    const human = { ...message(0, body.text), kind: "human" as const };
    await store.append({
      metadata: withOperation(ref, 1, human.id),
      roomEvents: [{ type: "message", message: human }],
    });
    assert.equal(store.metadata().rooms[0]!.operations![0]!.messageId, "m0");
  },
);
check(
  "receipt and human message recover from one unknown-sync complete transaction",
  async ({ options, keep, probe }) => {
    let store = keep(
      await AutomationTransactionStore.create(options, metadata()),
    );
    const human = { ...message(0, body.text), kind: "human" as const };
    const messageRef: AutomationOperationBodyRef = {
      ...ref,
      kind: "message",
      id: human.id,
    };
    probe.failSync = true;
    await assert.rejects(
      store.append({
        metadata: withOperation(messageRef, 1, human.id),
        roomEvents: [{ type: "message", message: human }],
      }),
      /unknown/,
    );
    probe.failSync = false;
    const generation = store.generation;
    await store.close();
    store = keep(await AutomationTransactionStore.open(options, generation));
    assert.equal(
      store.metadata().rooms[0]!.operations![0]!.messageId,
      human.id,
    );
    assert.deepEqual(await store.readOperationBody("room", messageRef), {
      text: body.text,
    });
    assert.equal("sync" in store.position, false);
  },
);
check(
  "quote fingerprint is stable across object key order, and introductions cannot quote",
  async ({ options, keep }) => {
    const quote = { messageId: "old", author: "You", text: "quoted" };
    assert.equal(
      fingerprintOperationBody({ text: "hello", replyTo: quote }),
      fingerprintOperationBody({
        text: "hello",
        replyTo: { text: "quoted", author: "You", messageId: "old" },
      }),
    );
    const store = keep(
      await AutomationTransactionStore.create(options, metadata()),
    );
    const fact = { ...body, replyTo: quote };
    const value = withOperation({
      ...ref,
      sha256: fingerprintOperationBody(fact),
    });
    value.rooms[0]!.operations![0]!.kind = "assistantIntroduction";
    await assert.rejects(
      store.append({ metadata: value, roomEvents: [fact] }),
      /incompatible/,
    );
  },
);
check(
  "body-ref argument is detached across an awaited indexed read",
  async ({ options, keep, probe }) => {
    const store = keep(
      await AutomationTransactionStore.create(options, metadata()),
    );
    await store.append({ metadata: withOperation(), roomEvents: [body] });
    const mutable = { ...ref };
    const pause = pauseRead(probe);
    const pending = store.readOperationBody("room", mutable);
    const settled = pending.then(
      () => {},
      () => {},
    );
    try {
      await pause.entered();
      mutable.sha256 = "a".repeat(64);
      mutable.id = "missing";
      pause.release();
      assert.deepEqual(await deadline(pending, "body read"), {
        text: body.text,
      });
    } finally {
      pause.release();
      await deadline(settled, "body cleanup");
    }
  },
);

check(
  "append detaches metadata and message inputs before awaiting, and returned metadata is isolated",
  async ({ options, keep }) => {
    const store = keep(
      await AutomationTransactionStore.create(options, metadata()),
    );
    const input = { metadata: metadata(1), roomEvents: [event(0)] };
    const pending = store.append(input);
    input.metadata.rooms[0]!.name = "Caller-mutated name";
    input.metadata.rooms[0]!.members[0]!.name = "Caller-mutated member";
    const inputEvent = input.roomEvents[0]!;
    assert.equal(inputEvent.type, "message");
    if (inputEvent.type !== "message") throw Error("Expected message fixture");
    inputEvent.message.text = "Caller-mutated body";
    await pending;
    assert.equal(store.metadata().rooms[0]!.name, "Synthetic");
    assert.equal(store.metadata().rooms[0]!.members[0]!.name, "Bot");
    assert.equal(
      (await store.readRoomMessage("room", "m0"))!.message.text,
      "Synthetic 0",
    );
    const returned = store.metadata();
    returned.rooms[0]!.name = "Returned-clone mutation";
    returned.rooms[0]!.members.splice(0);
    assert.equal(store.metadata().rooms[0]!.name, "Synthetic");
    assert.deepEqual(store.metadata().rooms[0]!.members, [
      { name: "Bot", threadId: "thread" },
    ]);
  },
);

check(
  "room rename and member changes retain old message facts but deletion invalidates old read snapshots",
  async ({ options, keep }) => {
    const store = keep(
      await AutomationTransactionStore.create(options, metadata()),
    );
    await store.append({ metadata: metadata(1), roomEvents: [event(0)] });
    const prior = store.roomSnapshot("room");
    const changed = metadata(1);
    changed.rooms[0]!.name = "Renamed synthetic room";
    changed.rooms[0]!.members = [
      { name: "Replacement", threadId: "replacement-thread" },
    ];
    await store.append({ metadata: changed, roomEvents: [] });
    assert.deepEqual(store.metadata(), changed);
    assert.deepEqual(
      (await store.readRoomMessage("room", "m0", prior))!.message,
      message(0),
    );
    await store.append({
      metadata: { triggers: [], history: [], rooms: [] },
      roomEvents: [],
    });
    assert.throws(() => store.roomSnapshot("room"), /not found/);
    await assert.rejects(
      store.readRoomPage("room", 0, prior),
      /snapshot|identity|boundary/i,
    );
    await assert.rejects(
      store.readRoomMessage("room", "m0", prior),
      /snapshot|identity|boundary/i,
    );
    assert.throws(
      () => store.hasRoomOrigin("room", "thread", "turn-0"),
      /not found/,
    );
    await assert.rejects(
      store.append({ metadata: metadata(1), roomEvents: [] }),
      /cannot be reused/,
    );
  },
);

check(
  "empty reaction update clears current reactions while pinned revisions survive reopening",
  async ({ options, keep }) => {
    let store = keep(
      await AutomationTransactionStore.create(options, metadata()),
    );
    await store.append({ metadata: metadata(1), roomEvents: [event(0)] });
    const beforeReaction = store.roomSnapshot("room");
    await store.append({ metadata: metadata(1), roomEvents: [reaction] });
    const withReaction = store.roomSnapshot("room");
    await store.append({
      metadata: metadata(1),
      roomEvents: [{ ...reaction, reactions: [] }],
    });
    const cleared = store.roomSnapshot("room");
    assert.equal(
      (await store.readRoomMessage("room", "m0"))!.message.reactions,
      undefined,
    );
    const generation = store.generation;
    await store.close();
    store = keep(await AutomationTransactionStore.open(options, generation));
    assert.equal(
      (await store.readRoomMessage("room", "m0", beforeReaction))!.message
        .reactions,
      undefined,
    );
    const pinned = (await store.readRoomMessage("room", "m0", withReaction))!;
    assert.deepEqual(pinned.message.reactions, reaction.reactions);
    assert.equal(pinned.reactionRevision, withReaction.revision);
    const current = (await store.readRoomMessage("room", "m0", cleared))!;
    assert.equal(current.message.reactions, undefined);
    assert.equal(current.reactionRevision, cleared.revision);
    assert.deepEqual(
      (await store.readRoomPage("room", 0, withReaction)).messages.map(
        (m) => m.id,
      ),
      ["m0"],
    );
  },
);

check(
  "otherwise valid aggregate metadata over quota rejects before I/O and leaves the writer usable",
  async ({ options, keep, probe }) => {
    const store = keep(
      await AutomationTransactionStore.create(options, metadata()),
    );
    const large: AutomationMetadata = {
      triggers: [],
      history: [],
      rooms: Array.from({ length: 50 }, (_, room) => ({
        id: `aggregate-room-${room}`,
        name: "Synthetic aggregate",
        createdAt: 0,
        messageCount: 0,
        members: Array.from({ length: 64 }, (_, member) => ({
          name: `Member-${member}-` + "n".repeat(110),
          threadId: `thread-${member}-` + "t".repeat(490),
        })),
      })),
    };
    // Prove this exceeds the aggregate byte quota, not an individual field/shape limit.
    const canonical = canonicalTriggerSnapshot({
      triggers: [],
      history: [],
      rooms: large.rooms.map(({ messageCount: _, ...room }) => ({
        ...room,
        messages: [],
      })),
    });
    assert.equal(canonical.rooms.length, 50);
    assert(canonical.rooms.every((room) => room.members.length === 64));
    assert(Buffer.byteLength(JSON.stringify(large)) > 1024 * 1024);
    const writes = probe.writes;
    await assert.rejects(
      store.append({ metadata: large, roomEvents: [] }),
      /byte limit/,
    );
    assert.equal(probe.writes, writes);
    await store.append({ metadata: metadata(1), roomEvents: [event(0)] });
    assert.equal(store.metadata().rooms[0]!.messageCount, 1);
  },
);

check(
  "large import frame incurs one explicit internal frame read while returning only a bounded page",
  async ({ options, keep, probe }) => {
    const store = keep(
      await AutomationTransactionStore.create(options, metadata()),
    );
    await store.append({
      metadata: metadata(200),
      roomEvents: Array.from({ length: 200 }, (_, id) =>
        event(id, "x".repeat(8000)),
      ),
    });
    probe.reads = 0;
    probe.readBytes = 0;
    const page = await store.readRoomPage("room");
    assert.deepEqual(
      page.messages.map((m) => m.id),
      ["m196", "m197", "m198", "m199"],
    );
    assert.equal(
      probe.reads,
      1,
      "same-frame page reads the targeted transaction once",
    );
    assert(
      probe.readBytes > 1024 * 1024,
      "a large import transaction still incurs whole-frame internal read overhead",
    );
    assert(
      probe.readBytes < 2 * 1024 * 1024,
      "this fixture reads its transaction, not unrelated history",
    );
    assert(
      Buffer.byteLength(JSON.stringify(page)) < 40_000,
      "bounded response size does not imply bounded four-body internal I/O",
    );
  },
);

check(
  "short append writes only its transaction and origin index survives reopening beyond 256 messages",
  async ({ options, keep, probe, file }) => {
    let store = keep(
      await AutomationTransactionStore.create(options, metadata()),
    );
    await store.append({
      metadata: metadata(320),
      roomEvents: Array.from({ length: 320 }, (_, id) =>
        event(id, "x".repeat(5000)),
      ),
    });
    const generation = store.generation;
    await store.close();
    store = keep(await AutomationTransactionStore.open(options, generation));
    probe.readBytes = 0;
    assert.equal(store.hasRoomOrigin("room", "thread", "turn-0"), true);
    assert.equal(store.hasRoomOrigin("room", "thread", "turn-319"), true);
    assert.equal(store.hasRoomOrigin("room", "thread", "not-recorded"), false);
    assert.equal(
      probe.readBytes,
      0,
      "origin queries use the reconstructed index",
    );
    const before = (await stat(file(store))).size;
    probe.writeBytes = 0;
    await store.append({ metadata: metadata(321), roomEvents: [event(320)] });
    assert.equal(probe.readBytes, 0, "append does not scan historical bodies");
    assert(
      probe.writeBytes > 0 && probe.writeBytes < 1500,
      "a short send writes bounded metadata and its one new message",
    );
    assert.equal((await stat(file(store))).size - before, probe.writeBytes);
    assert.equal(store.hasRoomOrigin("room", "thread", "turn-320"), true);
  },
);
