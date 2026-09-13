import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JsonlThreadJournal } from "../src/journal.js";
import { Thread } from "../src/thread.js";
import {
  codeStateFromItems,
  validateCodeStateWrite,
} from "../src/code-state.js";
import { decodeCanonicalItem, type CanonicalItem } from "../src/item.js";

const base = {
  threadId: "a",
  turnId: "turn",
  createdAt: "2026-09-09T00:00:00Z",
};
const parent: CanonicalItem = {
  ...base,
  id: "parent",
  type: "tool_call",
  callId: "code",
  name: "run_code",
  arguments: { code: "store('rows',[1]);" },
};
const state: CanonicalItem = {
  ...base,
  id: "state",
  type: "code_state",
  callId: "code",
  key: "rows",
  value: [1],
};
test("code values replay from JSONL, overwrite canonically, and require a code parent", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-code-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journal = new JsonlThreadJournal(directory);
  for (const item of [parent, state, { ...state, id: "state2", value: [2, 3] }])
    await journal.append(item);
  const items = await new JsonlThreadJournal(directory).read("a");
  assert.deepEqual(
    { ...codeStateFromItems(new Thread("a", items).items) },
    { rows: [2, 3] },
  );
  assert.throws(() => new Thread("a", [state]), /earlier run_code/);
  assert.throws(
    () => decodeCanonicalItem({ ...state, value: NaN }),
    /non-finite/,
  );
});
test("state quotas are enforced and special keys do not change the object prototype", () => {
  const values = codeStateFromItems([
    parent,
    { ...state, key: "__proto__", value: { safe: true } },
  ]);
  assert.equal(Object.getPrototypeOf(values), null);
  assert.deepEqual(values.__proto__, { safe: true });
  assert.throws(
    () => validateCodeStateWrite(values, "x", "a".repeat(256 * 1024)),
    /256 KiB/,
  );
  assert.throws(() => validateCodeStateWrite(values, "", 1), /1-160/);
  const full = Object.fromEntries(
    Array.from({ length: 128 }, (_, n) => [String(n), n]),
  );
  assert.throws(() => validateCodeStateWrite(full, "another", 1), /128 keys/);
});
