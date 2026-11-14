import assert from "node:assert/strict";
import test from "node:test";
import { roomFileOwnerLabels } from "../src/renderer/src/room-file-owner-labels.js";

const members = [
  {
    threadId: "private-a",
    title: "成员 A",
    workspacePath: "/not-for-display/a",
  },
  {
    threadId: "private-b",
    title: "成员 B",
    workspacePath: "/not-for-display/b",
  },
];
const file = (id: string, owner: string, path = "README.md") => ({
  id,
  path,
  resourceThreadId: owner,
  descriptor: { kind: "file" },
});
const tabs = [file("tab-a", "private-a"), file("tab-b", "private-b")];

test("only exact relative files shared by distinct Room owners gain projected labels", () => {
  const result = roomFileOwnerLabels(tabs, members);
  assert.equal(result.get("tab-a")?.title, "成员 A");
  assert.equal(result.get("tab-b")?.title, "成员 B");
  assert(!JSON.stringify([...result]).includes("private-"));
  assert(!JSON.stringify([...result]).includes("not-for-display"));
});

test("unique paths, same-owner duplicates, nonfiles and absent Room projection are no-ops", () => {
  assert.equal(roomFileOwnerLabels(tabs, undefined).size, 0);
  assert.equal(roomFileOwnerLabels([tabs[0]!], members).size, 0);
  assert.equal(
    roomFileOwnerLabels([tabs[0]!, file("other", "private-a")], members).size,
    0,
  );
  assert.equal(
    roomFileOwnerLabels(
      [tabs[0]!, file("other", "private-b", "docs/README.md")],
      members,
    ).size,
    0,
  );
  for (const kind of ["browser", "thread", "terminal", "custom"]) {
    assert.equal(
      roomFileOwnerLabels(
        tabs.map((tab) => ({ ...tab, descriptor: { kind } })),
        members,
      ).size,
      0,
    );
  }
});

test("does not normalize different paths or introduce absolute/path escape labels", () => {
  for (const path of [
    "/private/README.md",
    "C:\\private\\README.md",
    "../README.md",
  ]) {
    assert.equal(
      roomFileOwnerLabels(
        tabs.map((tab) => ({ ...tab, path })),
        members,
      ).size,
      0,
    );
  }
  assert.equal(
    roomFileOwnerLabels(
      [tabs[0]!, { ...tabs[1]!, path: "./README.md" }],
      members,
    ).size,
    0,
  );
});

test("missing, blank or equivalent owner titles do not invent numbers, names or ID fallbacks", () => {
  for (const projection of [
    [],
    [members[0]!],
    members.map((m) => ({ ...m, title: "" })),
    members.map((m) => ({ ...m, title: "Same" })),
    [
      { ...members[0]!, title: " A " },
      { ...members[1]!, title: "a" },
    ],
  ]) {
    assert.equal(roomFileOwnerLabels(tabs, projection).size, 0);
  }
});

test("long shared prefixes reuse exact suffixes and never depend on tab order", () => {
  const projection = members.map((m, i) => ({
    ...m,
    title: `Release readiness and documentation review ${i ? "Beta" : "Alpha"}`,
  }));
  const result = roomFileOwnerLabels(tabs, projection);
  assert.equal(result.get("tab-a")?.marked, "… Alpha");
  assert.equal(result.get("tab-a")?.bare, "Alpha");
  assert.deepEqual(
    [...roomFileOwnerLabels([...tabs].reverse(), projection)].reverse(),
    [...result],
  );
  for (const label of result.values())
    assert(label.title.endsWith(label.bare!));
});

test("renames and collision removal recompute presentation without mutating descriptors", () => {
  const original = structuredClone(tabs);
  const renamed = members.map((m, i) => ({
    ...m,
    title: i ? "Reviewer" : "Author",
  }));
  assert.equal(
    roomFileOwnerLabels(tabs, renamed).get("tab-a")?.title,
    "Author",
  );
  assert.deepEqual(tabs, original);
  assert.equal(roomFileOwnerLabels(tabs.slice(0, 1), renamed).size, 0);
});
