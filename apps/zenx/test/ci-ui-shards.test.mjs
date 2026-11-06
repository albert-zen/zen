import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
const ci = parse(
  readFileSync(
    new URL("../../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  ),
);
const job = ci.jobs["zenx-ui"];
test("UI shards keep all cases, isolate runners and never fail-fast sibling evidence", () => {
  assert.deepEqual(job.strategy.matrix.shard, [
    "overflow",
    "layout",
    "conversation",
  ]);
  assert.equal(job.strategy["fail-fast"], false);
  assert.equal(job.strategy["max-parallel"], 3);
  const captures = job.steps.filter((step) => step.run?.includes("capture-"));
  assert.equal(captures.length, 18);
  for (const capture of captures) {
    const owners = job.strategy.matrix.shard.filter((shard) =>
      capture.if.includes(`matrix.shard == '${shard}'`),
    );
    assert.equal(owners.length, 1, capture.name);
    const index = job.steps.indexOf(capture);
    const artifact = job.steps[index + 1];
    assert.match(artifact.uses, /actions\/upload-artifact/);
    assert.ok(artifact.if.includes(`matrix.shard == '${owners[0]}'`));
    assert.match(artifact.if, /always\(\)/);
    assert.equal(capture["continue-on-error"], undefined);
  }
  assert.deepEqual(ci.jobs.zenx.needs, ["zenx-check", "zenx-ui"]);
  assert.match(
    job.steps.find((step) => step.name === "Retain exact checkout provenance")
      .with.name,
    /matrix.shard/,
  );
});
