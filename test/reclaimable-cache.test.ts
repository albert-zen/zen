import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ReclaimableCache } from "../src/reclaimable-cache.js";

test("hot cache preserves live identity and invalidation after displacement", () => {
  const cache = new ReclaimableCache<string, object>(2);
  const first = {},
    second = {},
    third = {};
  cache.set("a", first);
  cache.set("b", second);
  cache.set("c", third);
  assert.equal(cache.has("a"), true);
  assert.equal(cache.get("a"), first);
  cache.delete("a");
  assert.equal(cache.has("a"), false);
  assert.equal(cache.get("a"), undefined);
  cache.set("a", third);
  assert.equal(cache.get("a"), third);
});

test("cache strongly retains only the most recently used entries", () => {
  const module = new URL("../src/reclaimable-cache.js", import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--expose-gc",
      "--input-type=module",
      "-e",
      `
    import assert from "node:assert/strict";
    import { ReclaimableCache } from ${JSON.stringify(module)};
    const cache = new ReclaimableCache(2);
    const refs = [];
    for (let i = 0; i < 32; i++) {
      const value = { history: Array(1000).fill(i) };
      refs.push(new WeakRef(value));
      cache.set(String(i), value);
    }
    assert.equal(cache.has("0"), true);
    for (let i = 0; i < 4; i++) {
      await new Promise(resolve => setTimeout(resolve, 0));
      global.gc();
    }
    assert.equal(refs.filter(ref => ref.deref() !== undefined).length, 2);
    assert.equal(cache.get("0"), undefined);
    assert.equal(cache.has("0"), false);
    assert.ok(cache.get("30"));
    assert.ok(cache.get("31"));
  `,
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
});
