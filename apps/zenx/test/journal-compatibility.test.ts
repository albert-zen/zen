import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ZenXJournalCompatibilityService,
  type JournalCompatibilityProjection,
} from "../src/main/journal-compatibility.js";

const temporaryDirectories: string[] = [];

test.afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

test("classifies current, useful legacy, unknown corruption, and ignored JSON by content", async () => {
  const root = await fixtureRoot();
  await writeJournal(root, "current", [currentMetadata("current")]);
  await writeJournal(root, "empty-legacy", [legacyCreated("empty-legacy")]);
  await writeJournal(root, "useful-legacy", [
    legacyCreated("useful-legacy"),
    legacyRecord("user.message.completed", "useful-legacy"),
  ]);
  await writeJournal(root, "unknown", [JSON.stringify({ version: 99 })]);
  await writeRawJournal(root, "corrupt", "{not-json\n");
  const ignoredJson = path.join(root, "threads", "old-thread.json");
  await writeFile(ignoredJson, "");

  const projection = await service(root).inspect();

  assert.deepEqual(projection.counts, {
    current: 1,
    knownLegacy: 2,
    legacyNoUsefulContent: 1,
    legacyUsefulContent: 1,
    unknown: 2,
    unavailable: 4,
  });
  assert.equal(
    classify(projection, "useful-legacy"),
    "known-legacy-useful-content",
  );
  assert.equal(classify(projection, "current"), "current");
  assert.equal(classify(projection, "unknown"), "unknown");
  assert.equal(
    await readFile(ignoredJson, "utf8"),
    "",
    "the current loader does not include ignored .json files",
  );
});

test("quarantines only known legacy files with no useful content and refreshes results", async () => {
  const root = await fixtureRoot();
  await writeJournal(root, "empty-legacy", [legacyCreated("empty-legacy")]);
  await writeJournal(root, "current", [currentMetadata("current")]);
  await writeJournal(root, "useful-legacy", [
    legacyCreated("useful-legacy"),
    legacyRecord("assistant.message.completed", "useful-legacy"),
  ]);
  await writeJournal(root, "unknown", [JSON.stringify({ nope: true })]);

  const compatibility = service(root);
  const result = await compatibility.quarantineLegacyNoUsefulContent();

  assert.deepEqual(
    result.moved.map((candidate) => candidate.threadId),
    ["empty-legacy"],
  );
  assert.equal(
    result.quarantineDirectory,
    path.join(root, "legacy-journal-quarantine"),
  );
  assert.equal(result.projection.counts.current, 1);
  assert.equal(result.projection.counts.legacyNoUsefulContent, 0);
  assert.equal(result.projection.counts.legacyUsefulContent, 1);
  assert.equal(result.projection.counts.unknown, 1);
  assert.equal(result.projection.counts.unavailable, 2);
  await assert.rejects(
    readFile(path.join(root, "threads", "empty-legacy.jsonl")),
  );
  assert.match(
    await readFile(
      path.join(root, "legacy-journal-quarantine", "empty-legacy.jsonl"),
      "utf8",
    ),
    /thread\.created/u,
  );
  await assert.doesNotReject(() => compatibility.refresh());
});

test("preserves useful legacy, current, unknown, and ignored files during cleanup", async () => {
  const root = await fixtureRoot();
  const currentPath = await writeJournal(root, "current", [
    currentMetadata("current"),
  ]);
  const usefulPath = await writeJournal(root, "useful", [
    legacyCreated("useful"),
    legacyRecord("turn.started", "useful"),
  ]);
  const unknownPath = await writeRawJournal(
    root,
    "unknown",
    JSON.stringify({ version: 1, item: { type: "future.event" } }),
  );
  const ignoredPath = path.join(root, "threads", "ignored.json");
  await writeFile(ignoredPath, "legacy json");
  await writeJournal(root, "remove", [legacyCreated("remove")]);

  await service(root).quarantineLegacyNoUsefulContent();

  assert.deepEqual(
    JSON.parse(await readFile(currentPath, "utf8")),
    JSON.parse(currentMetadata("current")),
  );
  assert.match(await readFile(usefulPath, "utf8"), /turn\.started/u);
  assert.equal(
    await readFile(unknownPath, "utf8"),
    JSON.stringify({ version: 1, item: { type: "future.event" } }),
  );
  assert.equal(await readFile(ignoredPath, "utf8"), "legacy json");
});

test("fails closed on a quarantine collision without moving the source", async () => {
  const root = await fixtureRoot();
  const source = await writeJournal(root, "collision", [
    legacyCreated("collision"),
  ]);
  const quarantine = path.join(root, "legacy-journal-quarantine");
  await mkdir(quarantine, { recursive: true });
  await writeFile(path.join(quarantine, "collision.jsonl"), "existing");

  await assert.rejects(
    service(root).quarantineLegacyNoUsefulContent(),
    /quarantine target already exists/u,
  );
  assert.match(await readFile(source, "utf8"), /thread\.created/u);
  assert.equal(
    await readFile(path.join(quarantine, "collision.jsonl"), "utf8"),
    "existing",
  );
});

test("rejects traversal or quarantine paths outside the official Zen root", async () => {
  const root = await fixtureRoot();
  assert.throws(
    () =>
      new ZenXJournalCompatibilityService({
        zenHome: root,
        quarantineDirectory: path.join(root, "..", "outside"),
      }),
    /quarantine must remain inside/u,
  );
  assert.throws(
    () =>
      new ZenXJournalCompatibilityService({
        zenHome: root,
        threadsDirectory: path.join(root, "..", "outside"),
      }),
    /threads must remain inside/u,
  );
});

test("rejects a quarantine directory nested inside active threads", async () => {
  const root = await fixtureRoot();
  const nested = path.join(root, "threads", "quarantine");
  assert.throws(
    () =>
      new ZenXJournalCompatibilityService({
        zenHome: root,
        quarantineDirectory: nested,
      }),
    /quarantine must be outside the threads directory/u,
  );
  await assert.rejects(readFile(nested), /ENOENT/u);
});

function service(root: string): ZenXJournalCompatibilityService {
  return new ZenXJournalCompatibilityService({ zenHome: root });
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-journal-compat-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "threads"), { recursive: true });
  return root;
}

async function writeJournal(
  root: string,
  threadId: string,
  records: readonly string[],
): Promise<string> {
  return await writeRawJournal(root, threadId, `${records.join("\n")}\n`);
}

async function writeRawJournal(
  root: string,
  threadId: string,
  contents: string,
): Promise<string> {
  const filePath = path.join(root, "threads", `${threadId}.jsonl`);
  await writeFile(filePath, contents, "utf8");
  return filePath;
}

function currentMetadata(threadId: string): string {
  return JSON.stringify({
    id: `${threadId}-metadata`,
    threadId,
    createdAt: "2026-08-13T00:00:00.000Z",
    type: "thread_metadata",
    cwd: "C:\\workspace",
    model: "fake",
    provider: "fake",
    sandbox: "danger-full-access",
    approvalPolicy: "never",
  });
}

function legacyCreated(threadId: string): string {
  return JSON.stringify({
    version: 1,
    item: {
      id: `thread-created:${threadId}`,
      type: "thread.created",
      createdAtMs: 0,
      seq: 0,
      runId: threadId,
      turnId: threadId,
      visibility: "internal",
      payload: { threadId },
    },
  });
}

function legacyRecord(type: string, threadId: string): string {
  return JSON.stringify({
    version: 1,
    item: {
      id: `${threadId}-item-1`,
      type,
      createdAtMs: 1,
      seq: 1,
      runId: "run-1",
      turnId: "turn-1",
      payload: { content: "useful" },
    },
  });
}

function classify(
  projection: JournalCompatibilityProjection,
  threadId: string,
): string | undefined {
  return projection.candidates.find(
    (candidate) => candidate.threadId === threadId,
  )?.classification;
}
