import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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

test("rejects a quarantine alias into active threads without moving a journal", async () => {
  const root = await fixtureRoot();
  const source = await writeJournal(root, "keep-source", [
    legacyCreated("keep-source"),
  ]);
  const active = path.join(root, "threads", "active");
  const alias = path.join(root, "quarantine-link");
  await mkdir(active);
  await directorySymlink(active, alias);

  await assert.rejects(
    new ZenXJournalCompatibilityService({
      zenHome: root,
      quarantineDirectory: alias,
    }).quarantineLegacyNoUsefulContent(),
    /symlink or reparse alias/u,
  );
  assert.match(await readFile(source, "utf8"), /thread\.created/u);
  await assert.rejects(
    access(path.join(active, "keep-source.jsonl")),
    /ENOENT/u,
  );
});

test("rejects a quarantine alias outside Zen before creating a child", async () => {
  const root = await fixtureRoot();
  const outside = await mkdtemp(path.join(os.tmpdir(), "zen-journal-outside-"));
  temporaryDirectories.push(outside);
  const source = await writeJournal(root, "keep-outside", [
    legacyCreated("keep-outside"),
  ]);
  const alias = path.join(root, "outside-link");
  const quarantine = path.join(alias, "child");
  await directorySymlink(outside, alias);

  await assert.rejects(
    new ZenXJournalCompatibilityService({
      zenHome: root,
      quarantineDirectory: quarantine,
    }).quarantineLegacyNoUsefulContent(),
    /symlink or reparse alias/u,
  );
  assert.match(await readFile(source, "utf8"), /thread\.created/u);
  await assert.rejects(access(path.join(outside, "child")), /ENOENT/u);
});

test("all entrypoints reject a default threads alias outside Zen without side effects", async () => {
  const root = await emptyFixtureRoot();
  const outside = await externalThreadsFixture("default-alias");
  const source = path.join(outside, "legacy.jsonl");
  const original = `${legacyCreated("legacy")}\n`;
  await writeFile(source, original, "utf8");
  await directorySymlink(outside, path.join(root, "threads"));
  const compatibility = new ZenXJournalCompatibilityService({ zenHome: root });

  await assert.rejects(compatibility.inspect(), /symlink or reparse alias/u);
  await assert.rejects(compatibility.refresh(), /symlink or reparse alias/u);
  await assert.rejects(
    compatibility.quarantineLegacyNoUsefulContent(),
    /symlink or reparse alias/u,
  );
  assert.equal(await readFile(source, "utf8"), original);
  await assert.rejects(
    access(path.join(root, "legacy-journal-quarantine")),
    /ENOENT/u,
  );
});

test("all entrypoints reject an aliased ancestor of custom threads", async () => {
  const root = await emptyFixtureRoot();
  const outside = await externalThreadsFixture("custom-alias");
  const externalThreads = path.join(outside, "threads");
  await mkdir(externalThreads);
  const source = path.join(externalThreads, "legacy.jsonl");
  const original = `${legacyCreated("legacy")}\n`;
  await writeFile(source, original, "utf8");
  const alias = path.join(root, "storage-link");
  await directorySymlink(outside, alias);
  const compatibility = new ZenXJournalCompatibilityService({
    zenHome: root,
    threadsDirectory: path.join(alias, "threads"),
  });

  await assert.rejects(compatibility.inspect(), /symlink or reparse alias/u);
  await assert.rejects(compatibility.refresh(), /symlink or reparse alias/u);
  await assert.rejects(
    compatibility.quarantineLegacyNoUsefulContent(),
    /symlink or reparse alias/u,
  );
  assert.equal(await readFile(source, "utf8"), original);
  await assert.rejects(
    access(path.join(root, "legacy-journal-quarantine")),
    /ENOENT/u,
  );
});

test("inspect supports a real Zen root before the threads directory exists", async () => {
  const root = await emptyFixtureRoot();
  const projection = await service(root).inspect();
  assert.deepEqual(projection.counts, {
    current: 0,
    knownLegacy: 0,
    legacyNoUsefulContent: 0,
    legacyUsefulContent: 0,
    unknown: 0,
    unavailable: 0,
  });
  await assert.rejects(access(path.join(root, "threads")), /ENOENT/u);
});

function service(root: string): ZenXJournalCompatibilityService {
  return new ZenXJournalCompatibilityService({ zenHome: root });
}

async function directorySymlink(target: string, alias: string): Promise<void> {
  await symlink(
    target,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
}

async function fixtureRoot(): Promise<string> {
  const root = await emptyFixtureRoot();
  await mkdir(path.join(root, "threads"), { recursive: true });
  return root;
}

async function emptyFixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-journal-compat-"));
  temporaryDirectories.push(root);
  return root;
}

async function externalThreadsFixture(label: string): Promise<string> {
  const outside = await mkdtemp(
    path.join(os.tmpdir(), `zen-journal-${label}-`),
  );
  temporaryDirectories.push(outside);
  return outside;
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
