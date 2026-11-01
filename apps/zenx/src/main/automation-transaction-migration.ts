import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { writeJournalPayload } from "../../../../src/journal-write.js";
import {
  assertOwnedFile,
  syncDirectory,
} from "../../../../src/storage-files.js";
import {
  JsonPluginStorage,
  withPluginStorageLease,
  type ZenXPluginHostSdkV1,
  type PluginStorageFileSystem,
} from "./plugin-host-sdk.js";
import { canonicalTriggerSnapshot } from "./trigger-store.js";
import type { TriggerSnapshot } from "./trigger-types.js";
import {
  AutomationTransactionStore,
  fingerprintOperationBody,
  type AutomationMetadata,
  type AutomationTransaction,
  type AutomationTransactionReceipt,
  type AutomationRoomEvent,
} from "./automation-transaction-store.js";

const OWNER = "zenx-triggers";
const PEER = "zenx-rooms";
const UUID =
  "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const GENERATION = new RegExp(`^${UUID}$`);
const BACKUP = new RegExp(`^legacy-${UUID}\\.json$`);
const ARTIFACT = new RegExp(
  `^(automation-${UUID}\\.jsonl|legacy-${UUID}\\.json)$`,
);
interface Marker {
  format: "zenx-automation-journal" | "zenx-automation-forward";
  generation: string;
  backup: string;
  backupSha256: string;
}
interface Container {
  version: number;
  value: Record<string, unknown>;
}
interface Backup {
  version: 1;
  sharedRaw: string | null;
  roomRaw: string | null;
  /** Original v1 Room source retained for explicit recovery, never automatic fallback. */
  legacyRoomRaw: string | null;
}
export type AutomationMigrationPhase =
  "both-gated" | "backup-durable" | "imported" | "forward-written" | "selected";
export interface AutomationMigrationOptions {
  storageRoot: string;
  loadLegacy?: () => Promise<TriggerSnapshot>;
  fileSystem?: PluginStorageFileSystem;
  /** Synthetic fault seam, never a production retry mechanism. */
  onPhase?: (phase: AutomationMigrationPhase) => Promise<void>;
}
export interface MigratedAutomationStorage {
  journal: AutomationTransactionStore;
  shared: JsonPluginStorage;
  rooms: JsonPluginStorage;
  /** Exactly one append under both existing marker queues; only Host-created handles are admitted. */
  append(
    transaction: AutomationTransaction,
    candidates?: {
      shared?: JsonPluginStorage | ZenXPluginHostSdkV1["storage"];
      rooms?: JsonPluginStorage | ZenXPluginHostSdkV1["storage"];
    },
  ): Promise<AutomationTransactionReceipt>;
  close(): Promise<void>;
}

const hash = (bytes: string) =>
  createHash("sha256").update(bytes).digest("hex");
function decode(raw: string): Container {
  const value = JSON.parse(raw) as Container;
  if (
    !value ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    !value.value ||
    typeof value.value !== "object" ||
    Array.isArray(value.value)
  )
    throw Error("Invalid automation storage container");
  return value;
}
function marker(value: Record<string, unknown>, forward: boolean): Marker {
  if (
    Object.keys(value).sort().join(",") !==
      "backup,backupSha256,format,generation" ||
    value.format !==
      (forward ? "zenx-automation-forward" : "zenx-automation-journal") ||
    typeof value.generation !== "string" ||
    !GENERATION.test(value.generation) ||
    typeof value.backup !== "string" ||
    !BACKUP.test(value.backup) ||
    typeof value.backupSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.backupSha256)
  )
    throw Error("Invalid automation storage marker");
  return value as unknown as Marker;
}
async function optionalRaw(
  filename: string,
  fs?: PluginStorageFileSystem,
): Promise<string | undefined> {
  try {
    return await (fs?.readFile ?? readFile)(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
export async function hasAutomationHistoryArtifacts(
  storageRoot: string,
): Promise<boolean> {
  try {
    return (
      await readdir(path.join(storageRoot, OWNER, "automation-history"))
    ).some((name) => ARTIFACT.test(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function loadBackup(
  directory: string,
  selected: Marker,
): Promise<Backup> {
  const filename = path.join(directory, selected.backup);
  await assertOwnedFile(filename);
  const raw = await readFile(filename, "utf8");
  if (hash(raw) !== selected.backupSha256)
    throw Error("Automation legacy backup checksum mismatch");
  const backup = JSON.parse(raw) as Backup;
  if (
    backup.version !== 1 ||
    ![backup.sharedRaw, backup.roomRaw, backup.legacyRoomRaw].every(
      (value) => value === null || typeof value === "string",
    )
  )
    throw Error("Invalid automation legacy backup");
  return backup;
}
async function saveBackup(
  directory: string,
  backup: Backup,
): Promise<Pick<Marker, "backup" | "backupSha256">> {
  const name = `legacy-${randomUUID()}.json`;
  const raw = JSON.stringify(backup) + "\n";
  const file = await open(path.join(directory, name), "wx", 0o600);
  try {
    await writeJournalPayload(file, raw);
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(directory);
  if ((await readFile(path.join(directory, name), "utf8")) !== raw)
    throw Error("Automation backup verification failed");
  return { backup: name, backupSha256: hash(raw) };
}

/** Imports bounded frames into an unselected generation. No historical effects are dispatched. */
async function importSnapshot(
  directory: string,
  snapshot: TriggerSnapshot,
  assertWriterLease: () => void,
): Promise<AutomationTransactionStore> {
  const metadata: AutomationMetadata = {
    triggers: snapshot.triggers,
    history: snapshot.history,
    rooms: snapshot.rooms.map(
      ({ messages: _messages, operations, ...room }) => ({
        ...room,
        messageCount: 0,
        ...(operations === undefined ? {} : { operations: [] }),
      }),
    ),
  };
  const journal = await AutomationTransactionStore.create(
    { directory, assertWriterLease, allowLegacyReceiptImport: true },
    metadata,
  );
  try {
    for (const room of snapshot.rooms) {
      const target = metadata.rooms.find(
        (candidate) => candidate.id === room.id,
      )!;
      let events: AutomationRoomEvent[] = [];
      let bytes = 0;
      const flush = async () => {
        if (!events.length) return;
        await journal.append({ metadata, roomEvents: events });
        events = [];
        bytes = 0;
      };
      for (const message of room.messages) {
        const event: AutomationRoomEvent = { type: "message", message };
        const size = Buffer.byteLength(JSON.stringify(event));
        if (events.length && (events.length >= 4 || bytes + size > 60 * 1024))
          await flush();
        target.messageCount++;
        events.push(event);
        bytes += size;
      }
      await flush();
      for (const operation of room.operations ?? []) {
        const { text, replyTo, ...bodyFree } = operation;
        const event: AutomationRoomEvent = {
          type: "operationBody",
          roomId: room.id,
          operationId: operation.id,
          ...(operation.messageId === null
            ? {}
            : { origin: "legacy-receipt" as const }),
          text,
          ...(replyTo === undefined ? {} : { replyTo }),
        };
        const size = Buffer.byteLength(JSON.stringify(event));
        if (events.length && (events.length >= 4 || bytes + size > 60 * 1024))
          await flush();
        (target.operations ??= []).push({
          ...bodyFree,
          bodyRef: {
            kind: "operation",
            id: operation.id,
            sha256: fingerprintOperationBody(event),
          },
        });
        events.push(event);
        bytes += size;
      }
      await flush();
    }
    return journal;
  } catch (error) {
    await journal.close();
    throw error;
  }
}

/** One-time cutover. Always inspect both namespaces before legacy initialization. */
export async function openAutomationTransactionStorage(
  options: AutomationMigrationOptions,
): Promise<MigratedAutomationStorage> {
  const root = path.resolve(options.storageRoot);
  const directory = path.join(root, OWNER, "automation-history");
  const sharedFile = path.join(root, OWNER, "storage.json");
  const roomFile = path.join(root, PEER, "storage.json");
  const fs = options.fileSystem;
  const [sharedRaw, roomRaw] = await Promise.all([
    optionalRaw(sharedFile, fs),
    optionalRaw(roomFile, fs),
  ]);
  const sharedContainer =
    sharedRaw === undefined ? undefined : decode(sharedRaw);
  const roomContainer = roomRaw === undefined ? undefined : decode(roomRaw);
  if ((sharedContainer?.version ?? 1) > 2 || (roomContainer?.version ?? 1) > 2)
    throw Error("Future automation storage version is unavailable");
  if (
    !sharedContainer &&
    (roomContainer?.version === 2 ||
      (await hasAutomationHistoryArtifacts(root)))
  )
    throw Error(
      "Shared automation marker is missing; refusing empty legacy bootstrap",
    );
  if (sharedContainer?.version !== 2 && roomContainer?.version === 2)
    throw Error(
      "Automation markers disagree; refusing to replace existing journal history from legacy data",
    );
  let closed = false;
  let shared: JsonPluginStorage | undefined;
  let rooms: JsonPluginStorage | undefined;
  let journal: AutomationTransactionStore | undefined;
  let mutationLease: { assertCurrent(): void } | undefined;
  const assertWriterLease = () => {
    if (closed) throw Error("Automation storage is closed");
    if (!mutationLease)
      throw Error("Automation append requires current marker leases");
    mutationLease.assertCurrent();
  };
  const storageOptions = (pluginId: string) => ({
    pluginId,
    root,
    version: 2,
    syncWrites: true,
    fileSystem: fs,
  });
  const openSelected = async (selected: Marker) => {
    shared = await JsonPluginStorage.open(storageOptions(OWNER));
    rooms = await JsonPluginStorage.open(storageOptions(PEER));
    const verifySelected = async () => {
      const owner = marker(await shared!.get(), false);
      const peer = marker(await rooms!.get(), true);
      for (const current of [owner, peer]) {
        if (
          current.generation !== selected.generation ||
          current.backup !== selected.backup ||
          current.backupSha256 !== selected.backupSha256
        )
          throw Error(
            "Automation markers changed while opening selected history",
          );
      }
    };
    await verifySelected();
    const opened = await AutomationTransactionStore.open(
      { directory, assertWriterLease },
      selected.generation,
    );
    try {
      await verifySelected();
    } catch (error) {
      await opened.close();
      throw error;
    }
    journal = opened;
  };
  if (sharedContainer?.version === 2) {
    const selected = marker(sharedContainer.value, false);
    if (roomContainer?.version !== 2)
      throw Error("Automation forward marker is missing or stale");
    const forward = marker(roomContainer.value, true);
    if (
      forward.generation !== selected.generation ||
      forward.backup !== selected.backup ||
      forward.backupSha256 !== selected.backupSha256
    )
      throw Error("Automation markers select different generations");
    await loadBackup(directory, selected);
    await openSelected(selected);
  } else {
    const fallback = options.loadLegacy
      ? await options.loadLegacy()
      : { triggers: [], history: [], rooms: [] };
    let roomPrepared:
      Awaited<ReturnType<typeof JsonPluginStorage.prepare>> | undefined;
    let sharedPrepared:
      Awaited<ReturnType<typeof JsonPluginStorage.prepare>> | undefined;
    let selected: Marker | undefined;
    try {
      sharedPrepared = await JsonPluginStorage.prepare({
        ...storageOptions(OWNER),
        initialValue: { ...fallback },
        migrations: [
          {
            fromVersion: 1,
            toVersion: 2,
            migrate: async (sharedValue) => {
              const build = async (
                roomValue: Record<string, unknown>,
                legacyRoomRaw: string | null,
              ) => {
                await options.onPhase?.("both-gated");
                const canonical = canonicalTriggerSnapshot({
                  triggers: sharedValue.triggers ?? fallback.triggers,
                  history: sharedValue.history ?? fallback.history,
                  rooms: sharedValue.rooms ?? roomValue.rooms ?? fallback.rooms,
                });
                await mkdir(directory, { recursive: true, mode: 0o700 });
                await syncDirectory(path.dirname(directory));
                const currentSharedRaw = await optionalRaw(sharedFile, fs);
                const currentRoomRaw = await optionalRaw(roomFile, fs);
                const backup = await saveBackup(directory, {
                  version: 1,
                  sharedRaw: currentSharedRaw ?? null,
                  roomRaw: currentRoomRaw ?? null,
                  legacyRoomRaw,
                });
                await options.onPhase?.("backup-durable");
                journal = await importSnapshot(directory, canonical, () => {
                  if (closed) throw Error("Automation migration is closed");
                });
                await options.onPhase?.("imported");
                selected = {
                  format: "zenx-automation-journal",
                  generation: journal.generation,
                  ...backup,
                };
                return { ...selected, format: "zenx-automation-forward" };
              };
              roomPrepared = await JsonPluginStorage.prepare({
                ...storageOptions(PEER),
                initialValue: { rooms: sharedValue.rooms ?? fallback.rooms },
                migrations: [
                  {
                    fromVersion: 1,
                    toVersion: 2,
                    migrate: async (roomValue) =>
                      build(
                        roomValue,
                        (await optionalRaw(roomFile, fs)) ?? null,
                      ),
                  },
                ],
              });
              if (!selected) {
                throw Error(
                  "Automation forward marker changed while acquiring migration gates",
                );
              }
              await options.onPhase?.("forward-written");
              return selected! as unknown as Record<string, unknown>;
            },
          },
        ],
      });
      if (!selected || !roomPrepared) {
        // The shared namespace became v2 after preflight; its migration callback
        // did not run. Do not infer that this call selected any generation.
        await sharedPrepared.rollback();
        throw Error(
          "Automation shared marker changed while acquiring migration gates",
        );
      }
      // Both marker writes were synced. Publishing releases only existing gates;
      // it neither dispatches a wakeup nor acknowledges a historical operation.
      sharedPrepared.publish();
      roomPrepared!.publish();
      await options.onPhase?.("selected");
      await journal!.close();
      journal = undefined;
      await openSelected(selected!);
    } catch (error) {
      // A visible new shared selector after failure is NOT proof of durability.
      // Preserve its matching forward marker and remain unavailable; never roll
      // the peer back beneath a possibly selected generation or ACK this call.
      let selectedVisible = true;
      try {
        const current = await optionalRaw(sharedFile, fs);
        selectedVisible =
          current !== undefined && decode(current).version === 2;
      } catch {
        /* unknown: retain the fences */
      }
      const failures: unknown[] = [error];
      if (!selectedVisible) {
        for (const prepared of [sharedPrepared, roomPrepared]) {
          try {
            await prepared?.rollback();
          } catch (rollbackError) {
            failures.push(rollbackError);
          }
        }
      }
      closed = true;
      await journal?.close();
      if (failures.length > 1)
        throw new AggregateError(
          failures,
          "Automation migration failed; rollback remains unavailable",
        );
      throw error;
    }
  }
  return {
    journal: journal!,
    shared: shared!,
    rooms: rooms!,
    async append(transaction, candidates = {}) {
      if (closed) throw Error("Automation storage is closed");
      return withPluginStorageLease(
        candidates.shared ?? shared!,
        async (ownerLease) =>
          withPluginStorageLease(
            candidates.rooms ?? rooms!,
            async (peerLease) => {
              for (const [lease, expectedFile, forward] of [
                [ownerLease, sharedFile, false],
                [peerLease, roomFile, true],
              ] as const) {
                lease.assertCurrent();
                if (lease.filename !== expectedFile || lease.version !== 2)
                  throw Error(
                    "Automation marker lease has a different namespace or version",
                  );
                const selected = marker(lease.value, forward);
                if (selected.generation !== journal!.generation)
                  throw Error(
                    "Automation marker lease selects a different generation",
                  );
              }
              if (mutationLease)
                throw Error("Automation mutation lease is already active");
              const token = {
                assertCurrent() {
                  ownerLease.assertCurrent();
                  peerLease.assertCurrent();
                },
              };
              mutationLease = token;
              try {
                return await journal!.append(transaction);
              } finally {
                if (mutationLease === token) mutationLease = undefined;
              }
            },
          ),
      );
    },
    async close() {
      closed = true;
      await journal!.close();
    },
  };
}
