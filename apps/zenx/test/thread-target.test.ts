import assert from "node:assert/strict";
import test from "node:test";
import { ZenXProjectProjection } from "../src/main/project-projection.js";
import {
  listThreadCandidates,
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

test("displayed short IDs remain unique even when an exact title collides with a prefix", async () => {
  const rows = [
    {
      id: "12345678aaa",
      name: "one",
      cwd: "/one",
      status: { type: "idle" as const },
    },
    {
      id: "12345678bbb",
      name: "12345678a",
      cwd: "/one",
      status: { type: "idle" as const },
    },
    {
      id: "elsewhere",
      name: "12345678aaa",
      cwd: "/two",
      status: { type: "idle" as const },
    },
  ];
  const port: ThreadTargetPort = {
    projectProjection: new ZenXProjectProjection(),
    async request(_method, params) {
      return { data: params.archived ? [] : rows, nextCursor: null };
    },
  };
  const candidates = await listThreadCandidates(port);
  assert.equal(candidates[0]?.shortId, "12345678aa");
  for (const candidate of candidates) {
    const resolved = await resolveThreadTarget(port, {
      target: candidate.shortId,
    });
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.threadId, candidate.threadId);
  }
  const full = await resolveThreadTarget(port, { target: "12345678aaa" });
  assert.equal(full.status, "resolved");
  assert.equal(full.threadId, "12345678aaa");
});
