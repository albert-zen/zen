import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { writeJournalPayload } from "../../../../src/journal-write.js";
import {
  assertOwnedFile,
  syncDirectory,
} from "../../../../src/storage-files.js";
import {
  canonicalTriggerSnapshot,
  isRoomMessage,
  isRoomReactions,
} from "./trigger-store.js";
import type {
  TriggerSnapshot,
  ZenXRoom,
  RoomMessage,
  RoomReaction,
  RoomSendOperation,
} from "./trigger-types.js";

const MAX_METADATA_BYTES = 1024 * 1024;
// Bounds one mutation/import batch, not retained history. Normal sends add one
// bounded message. Importers may split larger input into unselected batches.
const MAX_TRANSACTION_BYTES = 8 * 1024 * 1024;
const GENERATION =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const HASH = /^[a-f0-9]{64}$/u;
export type AutomationOperationBody = Pick<
  RoomSendOperation,
  "text" | "replyTo"
>;
export interface AutomationOperationBodyRef {
  kind: "operation" | "message";
  id: string;
  sha256: string;
}
export type AutomationOperationMetadata = Omit<
  RoomSendOperation,
  "text" | "replyTo"
> & {
  bodyRef: AutomationOperationBodyRef;
};
export function fingerprintOperationBody(
  body: AutomationOperationBody,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        text: body.text,
        ...(body.replyTo === undefined
          ? {}
          : {
              replyTo: {
                messageId: body.replyTo.messageId,
                author: body.replyTo.author,
                text: body.replyTo.text,
              },
            }),
      }),
    )
    .digest("hex");
}
export interface AutomationMetadata extends Omit<TriggerSnapshot, "rooms"> {
  rooms: Array<
    Omit<ZenXRoom, "messages" | "operations"> & {
      messageCount: number;
      operations?: AutomationOperationMetadata[];
    }
  >;
}
export type AutomationRoomEvent =
  | ({
      type: "operationBody";
      roomId: string;
      operationId: string;
      origin?: "legacy-receipt";
    } & AutomationOperationBody)
  | { type: "message"; message: RoomMessage }
  | {
      type: "reaction";
      roomId: string;
      messageId: string;
      reactions: RoomReaction[];
    };
export interface AutomationTransaction {
  metadata: AutomationMetadata;
  roomEvents: readonly AutomationRoomEvent[];
}
interface TransactionRecord extends AutomationTransaction {
  format: 1;
  generation: string;
  revision: number;
  previousHash: string | null;
}
interface Frame {
  record: TransactionRecord;
  sha256: string;
}
interface TransactionIndex {
  offset: number;
  length: number;
  hash: string;
}
interface EventIndex {
  revision: number;
  event: number;
  messageId: string;
}
interface IndexedEvent {
  roomId: string;
  entry: EventIndex;
  type: "message" | "reaction" | "operationBody";
  origin?: string;
}
interface BodyIndex {
  legacyReceipt?: boolean;
  entry: EventIndex;
  sha256: string;
  hasReply: boolean;
  kind?: RoomMessage["kind"];
}
interface RoomIndex {
  operationBindings: Map<string, { sha256: string; messageId: string | null }>;
  operationBodies: Map<string, BodyIndex>;
  messageBodies: Map<string, BodyIndex>;
  createdRevision: number;
  messages: Array<EventIndex & Pick<RoomMessage, "kind" | "createdAt">>;
  agentOrdinals: number[];
  byId: Map<string, number>;
  reactions: Map<string, EventIndex[]>;
  origins: Set<string>;
}
export interface AutomationPosition {
  generation: string;
  revision: number;
  hash: string;
}
export interface AutomationRoomSnapshot extends AutomationPosition {
  roomId: string;
  messageCount: number;
}
export interface AutomationTransactionReceipt extends AutomationPosition {
  sync: "file" | "file-and-directory";
}
export interface AutomationTransactionOptions {
  /** Existing Host-owned shared automation directory, not a renderer path. */
  directory: string;
  /** Existing service generation + mutation queue owns exclusivity. */
  assertWriterLease(): void;
  /** Host v1 import only; open() always disables new legacy facts. */
  allowLegacyReceiptImport?: boolean;
  /** IO seams; default behavior is the repository's existing platform contract. */
  openFile?: typeof open;
  syncDirectory?: typeof syncDirectory;
}
export class AutomationAppendOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super(
      "Automation transaction outcome is unknown; reconcile the actual log before continuing",
      { cause },
    );
  }
}

/** Sole shared automation fact log. No selector writes, external dispatch, replay,
 * second writer queue or persisted index. Not a general-purpose event store. */
export class AutomationTransactionStore {
  readonly generation: string;
  readonly #file: FileHandle;
  readonly #options: AutomationTransactionOptions;
  readonly #identity: Pick<Stats, "dev" | "ino">;
  #metadata: AutomationMetadata = { triggers: [], history: [], rooms: [] };
  #transactions: TransactionIndex[] = [];
  #rooms = new Map<string, RoomIndex>();
  #byteEnd = 0;
  #closed = false;
  #busy = false;
  #unknown = false;

  private constructor(
    options: AutomationTransactionOptions,
    file: FileHandle,
    generation: string,
    identity: Pick<Stats, "dev" | "ino">,
  ) {
    this.#identity = identity;
    this.#options = options;
    this.#file = file;
    this.generation = generation;
  }

  static async create(
    options: AutomationTransactionOptions,
    metadata: AutomationMetadata,
  ): Promise<AutomationTransactionStore> {
    options.assertWriterLease();
    const generation = randomUUID();
    const file = await (options.openFile ?? open)(
      filename(options.directory, generation),
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_RDWR |
        constants.O_APPEND |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      const store = new AutomationTransactionStore(
        options,
        file,
        generation,
        await file.stat(),
      );
      await store.append({ metadata, roomEvents: [] });
      return store;
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  /** generation comes from the migration/version marker. Readable frames are
   * recovery facts, not new success receipts and never a dispatch instruction. */
  static async open(
    options: AutomationTransactionOptions,
    generation: string,
  ): Promise<AutomationTransactionStore> {
    const target = filename(options.directory, generation);
    await assertOwnedFile(target);
    const file = await (options.openFile ?? open)(
      target,
      constants.O_RDWR | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const store = new AutomationTransactionStore(
        { ...options, allowLegacyReceiptImport: false },
        file,
        generation,
        await file.stat(),
      );
      const stat = await store.#assertNamedFile();
      if (!stat.isFile() || stat.nlink !== 1)
        throw Error("Automation journal must be an unaliased regular file");
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      let tail = Buffer.alloc(0);
      while (position < stat.size) {
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(buffer.length, stat.size - position),
          position,
        );
        if (!bytesRead)
          throw Error("Automation journal truncated during startup");
        position += bytesRead;
        const bytes = Buffer.concat([tail, buffer.subarray(0, bytesRead)]);
        let start = 0,
          end: number;
        while ((end = bytes.indexOf(10, start)) >= 0) {
          const line = bytes.subarray(start, end + 1);
          const frame = decode(line);
          const events = store.#validate(frame.record, true);
          store.#install(frame, events, line.length);
          start = end + 1;
        }
        tail = Buffer.from(bytes.subarray(start));
        if (tail.length > MAX_TRANSACTION_BYTES)
          throw Error("Automation transaction exceeds allocation bound");
      }
      if (tail.length || !store.#transactions.length)
        throw Error(
          "Automation journal has a partial or missing transaction; preserved without truncation",
        );
      if ((await store.#assertNamedFile()).size !== stat.size)
        throw Error("Automation journal changed during startup");
      return store;
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  get position(): AutomationPosition {
    this.#assertReadable();
    const revision = this.#transactions.length - 1;
    if (revision < 0)
      throw Error("Automation journal has no initial transaction");
    return {
      generation: this.generation,
      revision,
      hash: this.#transactions[revision]!.hash,
    };
  }
  metadata(): AutomationMetadata {
    this.#assertReadable();
    return structuredClone(this.#metadata);
  }

  async append(
    input: AutomationTransaction,
  ): Promise<AutomationTransactionReceipt> {
    this.#assertReadable();
    if (this.#busy)
      throw Error(
        "Automation transaction requires the existing mutation queue",
      );
    this.#options.assertWriterLease();
    // Bound/validate and detach caller objects before the first await. Invalid
    // input never starts a write and does not turn a known rejection into unknown.
    const record: TransactionRecord = JSON.parse(
      JSON.stringify({
        format: 1,
        generation: this.generation,
        revision: this.#transactions.length,
        previousHash: this.#transactions.at(-1)?.hash ?? null,
        metadata: input.metadata,
        roomEvents: input.roomEvents,
      }),
    ) as TransactionRecord;
    const events = this.#validate(record);
    const frame: Frame = { record, sha256: digest(record) };
    const text = JSON.stringify(frame) + "\n";
    if (Buffer.byteLength(text) > MAX_TRANSACTION_BYTES)
      throw Error("Automation transaction exceeds allocation bound");
    this.#busy = true;
    try {
      const stat = await this.#assertNamedFile();
      this.#options.assertWriterLease();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== this.#byteEnd)
        throw Error("Automation journal changed outside its writer");
      await writeJournalPayload(this.#file, text);
      this.#options.assertWriterLease();
      await this.#file.sync();
      this.#options.assertWriterLease();
      await (this.#options.syncDirectory ?? syncDirectory)(
        this.#options.directory,
      );
      const published = await this.#assertNamedFile();
      this.#options.assertWriterLease();
      if (published.size !== this.#byteEnd + Buffer.byteLength(text))
        throw Error("Automation journal length changed during append");
      this.#install(frame, events, Buffer.byteLength(text));
      return {
        ...this.position,
        sync: process.platform === "win32" ? "file" : "file-and-directory",
      };
    } catch (error) {
      this.#unknown = true;
      throw new AutomationAppendOutcomeUnknownError(error);
    } finally {
      this.#busy = false;
    }
  }

  roomSnapshot(roomId: string): AutomationRoomSnapshot {
    this.#assertReadable();
    const room = this.#metadata.rooms.find((room) => room.id === roomId);
    if (!room) throw Error("Room was not found");
    return { ...this.position, roomId, messageCount: room.messageCount };
  }
  async readOperationBody(
    roomId: string,
    ref: AutomationOperationBodyRef,
  ): Promise<AutomationOperationBody> {
    this.#assertReadable();
    ref = structuredClone(ref);
    if (!validBodyRef(ref)) throw Error("Invalid operation body reference");
    const room = this.#rooms.get(roomId);
    const indexed =
      ref.kind === "message"
        ? room?.messageBodies.get(ref.id)
        : room?.operationBodies.get(ref.id);
    if (!indexed || indexed.sha256 !== ref.sha256)
      throw Error("Operation body reference is missing or mismatched");
    const event = await this.#readEvent(indexed.entry, new Map());
    const body =
      event.type === "message"
        ? event.message
        : event.type === "operationBody"
          ? event
          : null;
    if (!body || fingerprintOperationBody(body) !== ref.sha256)
      throw Error("Operation body index mismatch");
    this.#assertReadable();
    return structuredClone({
      text: body.text,
      ...(body.replyTo === undefined ? {} : { replyTo: body.replyTo }),
    });
  }
  async readRoomMessage(
    roomId: string,
    messageId: string,
    snapshot = this.roomSnapshot(roomId),
  ): Promise<{
    message: RoomMessage;
    ordinal: number;
    reactionRevision: number;
    snapshot: AutomationRoomSnapshot;
  } | null> {
    const result = await this.#readMessage(
      roomId,
      messageId,
      structuredClone(snapshot),
      new Map(),
    );
    this.#assertReadable();
    return result;
  }
  async readRoomPage(
    roomId: string,
    cursor = 0,
    snapshot = this.roomSnapshot(roomId),
  ): Promise<{
    messages: RoomMessage[];
    reactionRevisions: Record<string, number>;
    nextCursor: number | null;
    snapshot: AutomationRoomSnapshot;
  }> {
    snapshot = structuredClone(snapshot);
    const room = this.#validateSnapshot(roomId, snapshot);
    if (
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      cursor > snapshot.messageCount
    )
      throw Error("Invalid Room message cursor");
    const end = snapshot.messageCount - cursor;
    let start = end;
    const messages: RoomMessage[] = [];
    const reactionRevisions: Record<string, number> = Object.create(null);
    const frames = new Map<number, Frame>();
    while (start > 0 && end - start < 4) {
      const read = await this.#readMessage(
        roomId,
        room.messages[start - 1]!.messageId,
        snapshot,
        frames,
      );
      if (!read) throw Error("Room message index missing");
      if (
        messages.length &&
        Buffer.byteLength(JSON.stringify([read.message, ...messages])) >
          60 * 1024
      )
        break;
      messages.unshift(read.message);
      reactionRevisions[read.message.id] = read.reactionRevision;
      start--;
    }
    this.#assertReadable();
    return {
      messages,
      reactionRevisions,
      nextCursor: start > 0 ? cursor + end - start : null,
      snapshot: structuredClone(snapshot),
    };
  }
  /** Same unread semantics as the existing Rooms projection, over body-free
   * index facts. Exact ID cursors use ordinal binary search, never body reads. */
  roomMessageReadProjection(
    roomId: string,
    readCursor: unknown,
    readSince: unknown,
  ) {
    this.roomSnapshot(roomId);
    const room = this.#rooms.get(roomId)!;
    const latest = room.messages.at(-1);
    const agentOrdinal = room.agentOrdinals.at(-1);
    const agent =
      agentOrdinal === undefined ? undefined : room.messages[agentOrdinal];
    const candidate =
      readCursor !== null &&
      typeof readCursor === "object" &&
      !Array.isArray(readCursor)
        ? (readCursor as Record<string, unknown>)
        : null;
    const cursor =
      candidate &&
      typeof candidate.id === "string" &&
      typeof candidate.createdAt === "number" &&
      Number.isFinite(candidate.createdAt)
        ? { id: candidate.id, createdAt: candidate.createdAt }
        : null;
    const index = cursor ? (room.byId.get(cursor.id) ?? -1) : -1;
    const since = cursor?.createdAt ?? readSince;
    let unreadCount: number | undefined;
    if (typeof since === "number" && Number.isFinite(since)) {
      if (index >= 0) {
        let low = 0,
          high = room.agentOrdinals.length;
        while (low < high) {
          const mid = Math.floor((low + high) / 2);
          if (room.agentOrdinals[mid]! <= index) low = mid + 1;
          else high = mid;
        }
        unreadCount = room.agentOrdinals.length - low;
      } else if (!(
        cursor &&
        room.agentOrdinals.some(
          (ordinal) => room.messages[ordinal]!.createdAt === since,
        )
      )) {
        unreadCount = room.agentOrdinals.filter(
          (ordinal) => room.messages[ordinal]!.createdAt > since,
        ).length;
      }
    }
    return {
      ...(latest
        ? {
            lastMessage: {
              id: latest.messageId,
              createdAt: latest.createdAt,
              kind: latest.kind,
            },
          }
        : {}),
      ...(agent
        ? {
            lastAgentMessage: {
              id: agent.messageId,
              createdAt: agent.createdAt,
            },
          }
        : {}),
      ...(unreadCount === undefined ? {} : { unreadCount }),
    };
  }

  hasRoomOrigin(roomId: string, threadId: string, turnId: string): boolean {
    this.roomSnapshot(roomId);
    return (
      this.#rooms
        .get(roomId)
        ?.origins.has(JSON.stringify([threadId, turnId])) ?? false
    );
  }
  async close(): Promise<void> {
    if (this.#busy)
      throw Error("Cannot close an in-flight automation transaction");
    if (this.#closed) return;
    this.#closed = true;
    await this.#file.close();
  }

  async #assertNamedFile(): Promise<Stats> {
    const [opened, named] = await Promise.all([
      this.#file.stat(),
      lstat(filename(this.#options.directory, this.generation)),
    ]);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      !named.isFile() ||
      named.nlink !== 1 ||
      opened.dev !== this.#identity.dev ||
      opened.ino !== this.#identity.ino ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino
    )
      throw Error("Automation journal named file identity changed");
    return opened;
  }

  #assertReadable(): void {
    if (this.#closed) throw Error("Automation transaction store is closed");
    if (this.#unknown)
      throw new AutomationAppendOutcomeUnknownError(
        "Writer is fenced; no cached state can establish the outcome",
      );
  }
  #validateSnapshot(
    roomId: string,
    snapshot: AutomationRoomSnapshot,
  ): RoomIndex {
    this.#assertReadable();
    if (
      !keys(snapshot, [
        "generation",
        "revision",
        "hash",
        "roomId",
        "messageCount",
      ]) ||
      snapshot.roomId !== roomId ||
      snapshot.generation !== this.generation ||
      !Number.isSafeInteger(snapshot.revision) ||
      snapshot.revision < 0 ||
      this.#transactions[snapshot.revision]?.hash !== snapshot.hash ||
      !Number.isSafeInteger(snapshot.messageCount) ||
      snapshot.messageCount < 0 ||
      !this.#metadata.rooms.some((room) => room.id === roomId)
    )
      throw Error("Invalid Room snapshot identity or transaction boundary");
    const room = this.#rooms.get(roomId);
    if (!room || room.createdRevision > snapshot.revision)
      throw Error("Room did not exist at this snapshot revision");
    let low = 0,
      high = room.messages.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (room.messages[mid]!.revision <= snapshot.revision) low = mid + 1;
      else high = mid;
    }
    if (snapshot.messageCount !== low)
      throw Error(
        "Room snapshot count does not match its transaction boundary",
      );
    return room;
  }
  async #readMessage(
    roomId: string,
    messageId: string,
    snapshot: AutomationRoomSnapshot,
    frames: Map<number, Frame>,
  ) {
    const room = this.#validateSnapshot(roomId, snapshot);
    const ordinal = room.byId.get(messageId);
    if (ordinal === undefined || ordinal >= snapshot.messageCount) return null;
    const entry = room.messages[ordinal]!;
    const event = await this.#readEvent(entry, frames);
    if (event.type !== "message") throw Error("Room message index mismatch");
    const message = structuredClone(event.message);
    const revisions = room.reactions.get(messageId) ?? [];
    let low = 0,
      high = revisions.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (revisions[mid]!.revision <= snapshot.revision) low = mid + 1;
      else high = mid;
    }
    const reaction = revisions[low - 1];
    if (reaction) {
      const update = await this.#readEvent(reaction, frames);
      if (update.type !== "reaction")
        throw Error("Room reaction index mismatch");
      if (update.reactions.length)
        message.reactions = structuredClone(update.reactions);
      else delete message.reactions;
    }
    return {
      message,
      ordinal,
      reactionRevision: reaction?.revision ?? entry.revision,
      snapshot: structuredClone(snapshot),
    };
  }
  async #readEvent(
    entry: EventIndex,
    frames: Map<number, Frame>,
  ): Promise<AutomationRoomEvent> {
    let frame = frames.get(entry.revision);
    if (!frame) {
      await this.#assertNamedFile();
      const index = this.#transactions[entry.revision]!;
      const bytes = Buffer.alloc(index.length);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await this.#file.read(
          bytes,
          offset,
          bytes.length - offset,
          index.offset + offset,
        );
        if (!result.bytesRead)
          throw Error("Automation transaction truncated after indexing");
        offset += result.bytesRead;
      }
      await this.#assertNamedFile();
      this.#assertReadable();
      frame = decode(bytes);
      if (
        frame.sha256 !== index.hash ||
        frame.record.generation !== this.generation ||
        frame.record.revision !== entry.revision
      )
        throw Error("Automation transaction changed after indexing");
      frames.set(entry.revision, frame);
    }
    this.#assertReadable();
    const event = frame.record.roomEvents[entry.event];
    if (!event) throw Error("Room event index missing");
    return event;
  }

  #validate(record: TransactionRecord, recovery = false): IndexedEvent[] {
    if (
      !keys(record, [
        "format",
        "generation",
        "revision",
        "previousHash",
        "metadata",
        "roomEvents",
      ]) ||
      record.format !== 1 ||
      record.generation !== this.generation ||
      record.revision !== this.#transactions.length ||
      record.previousHash !== (this.#transactions.at(-1)?.hash ?? null) ||
      !Array.isArray(record.roomEvents)
    )
      throw Error("Invalid automation transaction chain");
    record.metadata = validateMetadata(record.metadata);
    const roomIds = new Set(record.metadata.rooms.map((room) => room.id));
    const added = new Map<string, Set<string>>();
    const events: IndexedEvent[] = [];
    const bodies = new Map<string, Map<string, BodyIndex>>();
    const newMessages = new Map<string, Map<string, BodyIndex>>();
    record.roomEvents.forEach((event, index) => {
      let roomId: string, messageId: string, origin: string | undefined;
      if (
        keys(event, ["type", "message"]) &&
        event.type === "message" &&
        isRoomMessage(event.message)
      ) {
        roomId = event.message.roomId;
        messageId = event.message.id;
        const ids = added.get(roomId) ?? new Set<string>();
        if (this.#rooms.get(roomId)?.byId.has(messageId) || ids.has(messageId))
          throw Error("Duplicate Room message ID");
        ids.add(messageId);
        added.set(roomId, ids);
        if (
          event.message.kind === "agent" &&
          event.message.originThreadId !== null &&
          event.message.originTurnId !== null
        )
          origin = JSON.stringify([
            event.message.originThreadId,
            event.message.originTurnId,
          ]);
      } else if (
        event.type === "operationBody" &&
        keys(event, [
          "type",
          "roomId",
          "operationId",
          "text",
          ...(event.replyTo === undefined ? [] : ["replyTo"]),
          ...(event.origin === undefined ? [] : ["origin"]),
        ]) &&
        typeof event.roomId === "string" &&
        typeof event.operationId === "string" &&
        validOperationBody(event) &&
        (event.origin === undefined ||
          (event.origin === "legacy-receipt" &&
            (recovery || this.#options.allowLegacyReceiptImport === true)))
      ) {
        roomId = event.roomId;
        messageId = event.operationId;
        if (event.origin === "legacy-receipt") {
          const operation = record.metadata.rooms
            .find((room) => room.id === roomId)
            ?.operations?.find((operation) => operation.id === messageId);
          if (
            !operation ||
            operation.messageId === null ||
            operation.bodyRef.kind !== "operation" ||
            operation.bodyRef.id !== messageId ||
            operation.bodyRef.sha256 !== fingerprintOperationBody(event)
          )
            throw Error(
              "Legacy receipt body requires its bound committed operation in the same import transaction",
            );
        }
        if (
          this.#rooms.get(roomId)?.operationBodies.has(messageId) ||
          bodies.get(roomId)?.has(messageId)
        )
          throw Error("Duplicate immutable operation body ID");
        const prior = this.#rooms.get(roomId)?.operationBindings.get(messageId);
        if (prior && prior.sha256 !== fingerprintOperationBody(event))
          throw Error("Immutable operation body changed");
      } else if (
        keys(event, ["type", "roomId", "messageId", "reactions"]) &&
        event.type === "reaction" &&
        typeof event.roomId === "string" &&
        typeof event.messageId === "string" &&
        isRoomReactions(event.reactions)
      ) {
        roomId = event.roomId;
        messageId = event.messageId;
        if (
          !this.#rooms.get(roomId)?.byId.has(messageId) &&
          !added.get(roomId)?.has(messageId)
        )
          throw Error("Room reaction target is missing");
      } else throw Error("Invalid Room transaction event");
      if (!roomIds.has(roomId))
        throw Error("Room event has no current metadata owner");
      if (event.type === "message" || event.type === "operationBody") {
        const body = event.type === "message" ? event.message : event;
        const collection = event.type === "message" ? newMessages : bodies;
        const entries = collection.get(roomId) ?? new Map<string, BodyIndex>();
        entries.set(messageId, {
          entry: { revision: record.revision, event: index, messageId },
          sha256: fingerprintOperationBody(body),
          hasReply: body.replyTo !== undefined,
          ...(event.type === "message"
            ? { kind: event.message.kind }
            : { legacyReceipt: event.origin === "legacy-receipt" }),
        });
        collection.set(roomId, entries);
      }
      events.push({
        roomId,
        entry: { revision: record.revision, event: index, messageId },
        type: event.type,
        origin,
      });
    });
    for (const room of record.metadata.rooms) {
      for (const operation of room.operations ?? []) {
        const ref = operation.bodyRef;
        const prior = this.#rooms
          .get(room.id)
          ?.operationBindings.get(operation.id);
        if (
          prior &&
          (prior.sha256 !== ref.sha256 ||
            (prior.messageId !== null &&
              prior.messageId !== operation.messageId))
        )
          throw Error("Immutable operation binding changed");
        const immutableBody =
          bodies.get(room.id)?.get(operation.id) ??
          this.#rooms.get(room.id)?.operationBodies.get(operation.id);
        if (
          operation.messageId !== null &&
          !(ref.kind === "operation" && immutableBody?.legacyReceipt)
        ) {
          const committed =
            newMessages.get(room.id)?.get(operation.messageId) ??
            this.#rooms.get(room.id)?.messageBodies.get(operation.messageId);
          if (
            !committed ||
            committed.kind !== "human" ||
            committed.sha256 !== ref.sha256
          )
            throw Error(
              "Committed operation message body is missing or incompatible",
            );
        }
        if (immutableBody && immutableBody.sha256 !== ref.sha256)
          throw Error("Immutable operation body changed");
        const indexed =
          ref.kind === "message"
            ? (newMessages.get(room.id)?.get(ref.id) ??
              this.#rooms.get(room.id)?.messageBodies.get(ref.id))
            : (bodies.get(room.id)?.get(ref.id) ??
              this.#rooms.get(room.id)?.operationBodies.get(ref.id));
        if (
          !indexed ||
          indexed.sha256 !== ref.sha256 ||
          (ref.kind === "operation" && ref.id !== operation.id) ||
          (ref.kind === "message" &&
            (operation.messageId !== ref.id ||
              operation.kind !== undefined ||
              indexed.kind !== "human")) ||
          (operation.kind === "assistantIntroduction" && indexed.hasReply)
        )
          throw Error("Operation body reference is missing or incompatible");
      }
      if (
        this.#rooms.has(room.id) &&
        !this.#metadata.rooms.some((prior) => prior.id === room.id)
      )
        throw Error("Removed Room identities cannot be reused");
      if (
        room.messageCount !==
        (this.#rooms.get(room.id)?.messages.length ?? 0) +
          (added.get(room.id)?.size ?? 0)
      )
        throw Error("Room metadata count does not match transaction events");
    }
    return events;
  }
  #install(frame: Frame, events: IndexedEvent[], length: number): void {
    this.#transactions.push({
      offset: this.#byteEnd,
      length,
      hash: frame.sha256,
    });
    this.#byteEnd += length;
    this.#metadata = frame.record.metadata;
    for (const room of this.#metadata.rooms) {
      if (!this.#rooms.has(room.id))
        this.#rooms.set(room.id, emptyRoomIndex(frame.record.revision));
      for (const operation of room.operations ?? [])
        this.#rooms.get(room.id)!.operationBindings.set(operation.id, {
          sha256: operation.bodyRef.sha256,
          messageId: operation.messageId,
        });
    }
    for (const event of events) {
      const room = this.#rooms.get(event.roomId)!;
      this.#rooms.set(event.roomId, room);
      if (event.type === "message") {
        const body = frame.record.roomEvents[event.entry.event];
        if (body?.type !== "message")
          throw Error("Room message index mismatch");
        room.messageBodies.set(event.entry.messageId, {
          entry: event.entry,
          sha256: fingerprintOperationBody(body.message),
          hasReply: body.message.replyTo !== undefined,
          kind: body.message.kind,
        });
        room.byId.set(event.entry.messageId, room.messages.length);
        if (body.message.kind === "agent")
          room.agentOrdinals.push(room.messages.length);
        room.messages.push({
          ...event.entry,
          kind: body.message.kind,
          createdAt: body.message.createdAt,
        });
        if (event.origin) room.origins.add(event.origin);
      } else if (event.type === "operationBody") {
        const body = frame.record.roomEvents[event.entry.event];
        if (body?.type !== "operationBody")
          throw Error("Operation body index mismatch");
        room.operationBodies.set(event.entry.messageId, {
          entry: event.entry,
          sha256: fingerprintOperationBody(body),
          hasReply: body.replyTo !== undefined,
          legacyReceipt: body.origin === "legacy-receipt",
        });
      } else {
        const entries = room.reactions.get(event.entry.messageId) ?? [];
        entries.push(event.entry);
        room.reactions.set(event.entry.messageId, entries);
      }
    }
  }
}
function emptyRoomIndex(createdRevision: number): RoomIndex {
  return {
    createdRevision,
    operationBindings: new Map(),
    operationBodies: new Map(),
    messageBodies: new Map(),
    messages: [],
    agentOrdinals: [],
    byId: new Map(),
    reactions: new Map(),
    origins: new Set(),
  };
}
function keys(value: unknown, allowed: string[]): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === allowed.length &&
    Object.keys(value).every((key) => allowed.includes(key))
  );
}
function filename(directory: string, generation: string): string {
  if (!GENERATION.test(generation))
    throw Error("Invalid automation journal generation");
  return path.join(directory, `automation-${generation}.jsonl`);
}
function digest(record: TransactionRecord): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}
function validateMetadata(value: AutomationMetadata): AutomationMetadata {
  if (
    !keys(value, ["triggers", "history", "rooms"]) ||
    !Array.isArray(value.rooms)
  )
    throw Error("Invalid body-free automation metadata");
  if (
    Buffer.byteLength(JSON.stringify({ version: 2, value }, null, 2)) + 1 >
    MAX_METADATA_BYTES
  )
    throw Error("Automation metadata exceeds its byte limit");
  const counts = new Map<string, number>();
  const operationMetadata = new Map<string, AutomationOperationMetadata[]>();
  const rooms = value.rooms.map((room) => {
    if (
      !room ||
      typeof room !== "object" ||
      "messages" in room ||
      !Number.isSafeInteger(room.messageCount) ||
      room.messageCount < 0 ||
      counts.has(room.id)
    )
      throw Error("Invalid Room metadata count or identity");
    const { messageCount, operations, ...fields } = room;
    counts.set(room.id, messageCount);
    if (operations !== undefined && !Array.isArray(operations))
      throw Error("Invalid operation metadata");
    const placeholders = operations?.map((operation) => {
      if (
        !operation ||
        typeof operation !== "object" ||
        "text" in operation ||
        "replyTo" in operation ||
        !validBodyRef(operation.bodyRef)
      )
        throw Error("Invalid body-free operation metadata");
      const { bodyRef: _, ...fields } = operation;
      return { ...fields, text: "body-reference" };
    });
    if (operations) operationMetadata.set(room.id, operations);
    return {
      ...fields,
      ...(placeholders ? { operations: placeholders } : {}),
      messages: [],
    };
  });
  const canonical = canonicalTriggerSnapshot({ ...value, rooms });
  return {
    ...canonical,
    rooms: canonical.rooms.map(({ messages: _, operations: __, ...room }) => ({
      ...room,
      ...(operationMetadata.has(room.id)
        ? { operations: structuredClone(operationMetadata.get(room.id)!) }
        : {}),
      messageCount: counts.get(room.id)!,
    })),
  };
}
function decode(bytes: Buffer): Frame {
  if (bytes.length > MAX_TRANSACTION_BYTES || bytes.at(-1) !== 10)
    throw Error("Invalid automation transaction framing bound");
  let value: Frame;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as Frame;
  } catch {
    throw Error("Invalid automation transaction JSON");
  }
  if (
    !keys(value, ["record", "sha256"]) ||
    typeof value.sha256 !== "string" ||
    !HASH.test(value.sha256) ||
    value.sha256 !== digest(value.record)
  )
    throw Error("Automation transaction checksum mismatch");
  return value;
}
function validBodyRef(ref: AutomationOperationBodyRef): boolean {
  return (
    keys(ref, ["kind", "id", "sha256"]) &&
    (ref.kind === "message" || ref.kind === "operation") &&
    typeof ref.id === "string" &&
    ref.id.length > 0 &&
    typeof ref.sha256 === "string" &&
    HASH.test(ref.sha256)
  );
}
function validOperationBody(
  body: AutomationOperationBody & { operationId: string; roomId: string },
): boolean {
  return isRoomMessage({
    id: body.operationId,
    roomId: body.roomId,
    kind: "human",
    author: "You",
    text: body.text,
    createdAt: 0,
    originThreadId: null,
    originTurnId: null,
    ...(body.replyTo === undefined ? {} : { replyTo: body.replyTo }),
  });
}
