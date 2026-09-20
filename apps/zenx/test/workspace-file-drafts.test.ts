import assert from "node:assert/strict";
import test from "node:test";

import {
  WorkspaceFileDrafts,
  fileDraftKey,
} from "../src/renderer/src/workspace-file-drafts.js";

const wait = async (milliseconds = 15) =>
  await new Promise((resolve) => setTimeout(resolve, milliseconds));

test("autosave serializes an in-flight snapshot without losing newer input", async () => {
  const drafts = new WorkspaceFileDrafts(5);
  const key = fileDraftKey("thread", "README.md");
  drafts.set(key, {
    base: { path: "README.md", text: "before", revision: "r1" },
    text: "before",
  });
  const calls: Array<{
    text: string;
    revision: string;
    resolve(value: {
      status: "saved";
      file: { path: string; text: string; revision: string };
    }): void;
  }> = [];
  const save = (text: string, revision: string) =>
    new Promise<{
      status: "saved";
      file: { path: string; text: string; revision: string };
    }>((resolve) => calls.push({ text, revision, resolve }));

  drafts.edit(key, "first", save);
  await wait();
  assert.deepEqual(
    calls.map(({ text, revision }) => [text, revision]),
    [["first", "r1"]],
  );
  drafts.edit(key, "second", save);
  calls[0]!.resolve({
    status: "saved",
    file: { path: "README.md", text: "first", revision: "r2" },
  });
  await wait();
  assert.deepEqual(
    calls.map(({ text, revision }) => [text, revision]),
    [
      ["first", "r1"],
      ["second", "r2"],
    ],
  );
  calls[1]!.resolve({
    status: "saved",
    file: { path: "README.md", text: "second", revision: "r3" },
  });
  await wait();
  assert.deepEqual(drafts.snapshot().get(key), {
    base: { path: "README.md", text: "second", revision: "r3" },
    text: "second",
    saving: false,
  });
});

test("autosave stops after failure and retries only after editing or Retry", async () => {
  const drafts = new WorkspaceFileDrafts(5);
  const key = fileDraftKey("thread", "notes.txt");
  drafts.set(key, {
    base: { path: "notes.txt", text: "before", revision: "r1" },
    text: "before",
  });
  let attempts = 0;
  const save = async (text: string) => {
    attempts += 1;
    if (attempts === 1) throw new Error("disk unavailable");
    return {
      status: "saved" as const,
      file: { path: "notes.txt", text, revision: "r2" },
    };
  };
  drafts.edit(key, "first", save);
  await wait();
  await wait(30);
  assert.equal(attempts, 1);
  assert.equal(drafts.snapshot().get(key)?.error, "disk unavailable");
  drafts.edit(key, "second", save);
  await wait();
  assert.equal(attempts, 2);
  assert.equal(drafts.snapshot().get(key)?.text, "second");
  assert.equal(drafts.snapshot().get(key)?.error, undefined);
});

test("drafts remain isolated across threads while one tab autosaves", async () => {
  const drafts = new WorkspaceFileDrafts(5);
  const first = fileDraftKey("thread-a", "README.md");
  const second = fileDraftKey("thread-b", "README.md");
  drafts.set(first, {
    base: { path: "README.md", text: "a", revision: "a1" },
    text: "a",
  });
  drafts.set(second, {
    base: { path: "README.md", text: "b", revision: "b1" },
    text: "b draft",
  });
  drafts.edit(first, "a saved", async (text) => ({
    status: "saved",
    file: { path: "README.md", text, revision: "a2" },
  }));
  await wait();
  assert.equal(drafts.snapshot().get(first)?.text, "a saved");
  assert.equal(drafts.snapshot().get(second)?.text, "b draft");
  assert.equal(drafts.snapshot().get(second)?.base.revision, "b1");
});
