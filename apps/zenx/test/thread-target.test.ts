import assert from "node:assert/strict";
import test from "node:test";
import { ZenXProjectProjection } from "../src/main/project-projection.js";
import {
  resolveThreadTarget,
  type ThreadTargetPort,
} from "../src/main/thread-target.js";

test("thread targets resolve full IDs, unique prefixes and exact titles across every list page", async () => {
  const rows = [
    {
      id: "aaa111",
      name: "Review",
      cwd: "/one",
      status: { type: "idle" as const },
    },
    {
      id: "aaa222",
      name: "Review",
      cwd: "/two",
      status: { type: "idle" as const },
    },
    {
      id: "bbb111",
      name: "Release",
      cwd: "/one",
      status: { type: "idle" as const },
    },
  ];
  const port: ThreadTargetPort = {
    projectProjection: new ZenXProjectProjection(),
    async request(_method, params) {
      const selected = params.archived ? rows.slice(2) : rows.slice(0, 2);
      const offset = Number(params.cursor ?? 0);
      return {
        data: selected.slice(offset, offset + 1),
        nextCursor: offset + 1 < selected.length ? String(offset + 1) : null,
      };
    },
  };
  for (const target of ["bbb111", "bbb", "Release"]) {
    const result = await resolveThreadTarget(port, { target });
    assert.equal(result.status, "resolved");
    if (result.status === "resolved") {
      assert.equal(result.threadId, "bbb111");
      assert.equal(result.candidate.archived, true);
    }
  }
  for (const target of ["aaa", "Review"]) {
    const result = await resolveThreadTarget(port, { target });
    assert.equal(result.status, "ambiguous");
    if (result.status !== "resolved")
      assert.deepEqual(
        result.candidates.map((c) => c.threadId),
        ["aaa111", "aaa222"],
      );
  }
  assert.equal(
    (await resolveThreadTarget(port, { target: "Rev" })).status,
    "not_found",
  );
  const scoped = await resolveThreadTarget(port, {
    target: "Review",
    workspace: "/one",
  });
  assert.equal(scoped.status, "resolved");
  if (scoped.status === "resolved") assert.equal(scoped.threadId, "aaa111");
});
