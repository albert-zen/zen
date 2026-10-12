import assert from "node:assert/strict";
import test from "node:test";
import {
  ObservationPresentation,
  observationReadOptions,
  MAX_OBSERVATION_PAGE_BYTES,
} from "../src/main/capabilities/observation-presentation.js";
import type { ObservationCapture } from "../src/main/capabilities/observation-capture.js";

interface Item {
  targetId: string;
  name: string;
  value?: string;
  checked?: boolean;
  options?: string[];
}
type Output = Record<string, any>;

function presenter(pageItems = 80, now?: () => number) {
  return new ObservationPresentation<Item>({
    itemsField: "targets",
    changesField: "targetChanges",
    textField: "visibleText",
    pageItems,
    identityKind: "dom-node",
    getId: (item) => item.targetId,
    withId: (item, targetId) => ({ ...item, targetId }),
    ...(now === undefined ? {} : { now }),
  });
}
function capture(
  revision: number,
  count = 80,
  text = "unchanged document ".repeat(500),
): ObservationCapture<Item> {
  return {
    scopeKey: "document-one",
    entries: Array.from({ length: count }, (_, i) => ({
      identity: `node-${i}`,
      value: {
        targetId: `raw-${revision}-${i}`,
        name: `Control ${i} ${"label ".repeat(8)}`,
        value: "old",
        checked: false,
      },
    })),
    text,
    coverage: {
      scope: "main-document text and viewport controls",
      sourceComplete: true,
      reasons: [],
      itemTotal: count,
      textTotal: text.length,
    },
  };
}
function publish(
  p: ObservationPresentation<Item>,
  id: string,
  c: ObservationCapture<Item>,
  options = {},
  key = "owner/tab",
): Output {
  return p.publish(key, id, { observationId: id, title: "Page" }, c, options);
}
function apply(base: Output, delta: Output): Output {
  assert.equal(delta.observation.baseObservationId, base.observationId);
  const items = new Map<string, Item>(
    base.targets.map((item: Item) => [item.targetId, item]),
  );
  for (const id of delta.targetChanges.removedFromView) items.delete(id);
  for (const item of [
    ...delta.targetChanges.added,
    ...delta.targetChanges.updated,
  ])
    items.set(item.targetId, item);
  const order: string[] = delta.targetChanges.order ?? [...items.keys()];
  return {
    ...delta,
    targets: order.map((id) => items.get(id)),
    visibleText: delta.visibleText ?? base.visibleText,
  };
}

test("full plus structural/value/check/text diff reconstructs the exact fresh bounded view", () => {
  const p = presenter();
  const first = publish(p, "obs1", capture(1));
  const next = capture(2);
  next.entries[3]!.value.name = "Renamed surviving control";
  next.entries[4]!.value.checked = true;
  next.entries[5]!.value.value = "new value";
  next.entries.splice(10, 1);
  next.entries.push({
    identity: "new-node",
    value: { targetId: "raw-new", name: "New" },
  });
  [next.entries[0], next.entries[1]] = [next.entries[1]!, next.entries[0]!];
  const delta = publish(p, "obs2", next, { baseObservationId: "obs1" });
  assert.equal(delta.observation.format, "diff");
  const actual = apply(first, delta);
  const full = publish(p, "obs3", captureEquivalent(next, 3), { full: true });
  assert.deepEqual(actual.targets, full.targets);
  assert.equal(actual.visibleText, full.visibleText);
  assert.deepEqual(actual.coverage, full.coverage);
  assert.deepEqual(delta.targetChanges.removedFromView, ["raw-1-10"]);
  assert.equal(delta.targetChanges.updated.length, 3);
});

function captureEquivalent(
  c: ObservationCapture<Item>,
  revision: number,
): ObservationCapture<Item> {
  return {
    ...c,
    entries: c.entries.map((entry, i) => ({
      ...entry,
      value: { ...entry.value, targetId: `raw-${revision}-${i}` },
    })),
  };
}

test("unchanged view emits small diff while action references resolve to the fresh native snapshot", async () => {
  const p = presenter();
  const first = publish(p, "obs1", capture(1));
  const second = publish(p, "obs2", capture(2), { baseObservationId: "obs1" });
  assert.equal(second.observation.format, "diff");
  assert.equal(second.observation.unchanged, true);
  assert.equal(second.visibleText, undefined);
  assert.equal(
    await p.resolveAction("owner/tab", "obs2", first.targets[0].targetId),
    "raw-2-0",
  );
  await assert.rejects(
    p.resolveAction("owner/tab", "obs1", first.targets[0].targetId),
    /stale/,
  );
  const fullBytes = Buffer.byteLength(JSON.stringify(first));
  const deltaBytes = Buffer.byteLength(JSON.stringify(second));
  assert.ok(deltaBytes < fullBytes);
  process.stdout.write(
    `observation fixture serialized bytes: full=${fullBytes}, unchanged diff=${deltaBytes}\n`,
  );
});

test("new document, missing base and explicit full produce self-contained resets", () => {
  const p = presenter();
  publish(p, "one", capture(1));
  const next = capture(2);
  next.scopeKey = "new-document";
  const reset = publish(p, "two", next, { baseObservationId: "one" });
  assert.equal(reset.observation.format, "full");
  assert.equal(reset.observation.resetReason, "scope-changed");
  assert.equal(reset.targets[0].targetId, "raw-2-0");
  const missing = publish(p, "three", next, {
    baseObservationId: "foreign-or-compacted",
  });
  assert.equal(missing.observation.resetReason, "base-unavailable");
  const full = publish(p, "four", next, {
    baseObservationId: "three",
    full: true,
  });
  assert.equal(full.observation.resetReason, "requested-full");
  assert.ok(full.targets.length > 0);
});

test("cursor pages reconstruct captured tails beyond former limits without changing observation or first-page baseline", async () => {
  const p = presenter();
  const c = capture(1, 200, "一段完整文本🙂".repeat(3000));
  const first = publish(p, "one", c);
  const targets = [...first.targets];
  let text = first.visibleText;
  let cursor = first.nextCursor as string | undefined;
  while (cursor !== undefined) {
    const page = (await p.read("owner/tab", cursor)) as Output;
    assert.equal(page.observationId, "one");
    assert.equal(page.observation.continuation, true);
    assert.equal(
      page.coverage.complete,
      false,
      "a tail page alone is not a complete snapshot",
    );
    assert.equal(page.observation.baseObservationId, undefined);
    targets.push(...page.targets);
    text += page.visibleText;
    cursor = page.nextCursor;
  }
  assert.equal(targets.length, 200);
  assert.equal(text, c.text);
  const diff = publish(p, "two", captureEquivalent(c, 2), {
    baseObservationId: "one",
  });
  assert.equal(diff.observation.format, "diff");
  assert.equal(diff.observation.unchanged, true);
  assert.equal(diff.coverage.items.offset, 0);
  assert.equal(
    await p.resolveAction("owner/tab", "two", first.targets[0].targetId),
    "raw-2-0",
  );
  await assert.rejects(
    p.resolveAction("owner/tab", "two", targets[199].targetId),
    /not returned/,
  );
});

test("native omissions remain explicit on every page including the last", async () => {
  const p = presenter(2);
  const c = capture(1, 5, "");
  c.coverage = {
    scope: "native traversal",
    sourceComplete: null,
    reasons: ["depth_limit_unknown"],
  };
  let out = publish(p, "one", c);
  for (;;) {
    assert.equal(out.coverage.complete, false);
    assert.equal(out.coverage.sourceComplete, null);
    assert.deepEqual(out.coverage.reasons, ["depth_limit_unknown"]);
    if (out.nextCursor === undefined) break;
    out = await p.read("owner/tab", out.nextCursor);
  }
});

test("mutations, owner changes, native invalidation and retirement revoke cursor and actions", async () => {
  const p = presenter(2);
  let current = true;
  const c = capture(1, 4, "");
  c.assertCurrent = () => {
    if (!current) throw new Error("native observation stale");
  };
  const first = publish(p, "one", c);
  await assert.rejects(
    p.read("other-owner/tab", first.nextCursor),
    /unavailable/,
  );
  await assert.rejects(
    p.resolveAction("other-owner/tab", "one", first.targets[0].targetId),
    /unavailable/,
  );
  current = false;
  await assert.rejects(
    p.read("owner/tab", first.nextCursor),
    /native observation stale/,
  );
  current = true;
  const next = publish(p, "two", c);
  p.invalidate("owner/tab");
  await assert.rejects(p.read("owner/tab", next.nextCursor), /consumed/);
  const third = publish(p, "three", c);
  p.close();
  await assert.rejects(p.read("owner/tab", third.nextCursor), /unavailable/);
});

test("async native validation cannot publish a cursor/action after capture replacement", async () => {
  const p = presenter(2);
  let finish!: () => void;
  const c = capture(1, 4, "");
  c.assertCurrent = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  const first = publish(p, "one", c);
  const pending = p.read("owner/tab", first.nextCursor);
  publish(p, "two", capture(2, 4, ""));
  finish();
  await assert.rejects(pending, /changed or expired/);
});

test("five-minute expiry and bounded cache eviction require explicit fresh capture", async () => {
  let now = 0;
  const p = presenter(2, () => now);
  const first = publish(p, "one", capture(1, 4, ""));
  now = 300001;
  await assert.rejects(p.read("owner/tab", first.nextCursor), /expired/);
  const recovered = publish(p, "two", capture(2), { baseObservationId: "one" });
  assert.equal(recovered.observation.resetReason, "base-unavailable");
  for (let i = 0; i < 65; i++)
    publish(p, `capture-${i}`, capture(i, 1, ""), {}, `owner/tab-${i}`);
  assert.equal(p.has("owner/tab-0"), false);
  const evicted = publish(
    p,
    "next",
    capture(3),
    { baseObservationId: "capture-0" },
    "owner/tab-0",
  );
  assert.equal(evicted.observation.resetReason, "base-unavailable");
});

test("a replacement microtask between native validation and cursor resume retires the old capture", async () => {
  const p = presenter(2);
  let finish!: () => void;
  const c = capture(1, 4, "");
  c.assertCurrent = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  const first = publish(p, "one", c);
  const pending = p.read("owner/tab", first.nextCursor);
  finish();
  queueMicrotask(() => {
    publish(p, "two", capture(2, 4, ""));
  });
  await assert.rejects(pending, /changed or expired/);
});

test("duplicate identities never inherit another node's stable reference", () => {
  const p = presenter();
  publish(p, "one", capture(1));
  const c = capture(2);
  c.entries[1]!.identity = c.entries[0]!.identity;
  const next = publish(p, "two", c);
  assert.equal(next.targets[0].targetId, "raw-2-0");
  assert.equal(next.targets[1].targetId, "raw-2-1");
});

test("returned and backend objects cannot mutate the retained immutable capture", async () => {
  const p = presenter(1);
  const c = capture(1, 2, "");
  c.entries[1]!.value.options = ["original"];
  const first = publish(p, "one", c);
  c.entries[1]!.value.options[0] = "backend changed";
  first.targets[0].name = "caller changed";
  const page = (await p.read("owner/tab", first.nextCursor)) as Output;
  assert.deepEqual(page.targets[0].options, ["original"]);
  page.targets[0].options[0] = "caller changed again";
  const repeated = (await p.read("owner/tab", first.nextCursor)) as Output;
  assert.deepEqual(repeated.targets[0].options, ["original"]);
});

test("large source capture is truthfully bounded and each serialized page fits output budget", async () => {
  const p = presenter();
  const c = capture(1, 600, "x".repeat(200000));
  let out = publish(p, "one", c);
  let count = 0;
  let chars = 0;
  for (;;) {
    assert.ok(
      Buffer.byteLength(JSON.stringify(out)) <= MAX_OBSERVATION_PAGE_BYTES,
    );
    assert.equal(out.coverage.sourceComplete, false);
    assert.ok(out.coverage.reasons.includes("host_capture_budget"));
    count += out.targets.length;
    chars += out.visibleText.length;
    if (out.nextCursor === undefined) break;
    out = await p.read("owner/tab", out.nextCursor);
  }
  assert.equal(count, 512);
  assert.equal(chars, 128000);
});

test("cursor/base/full input rejects conflicting or malformed recovery requests", () => {
  assert.throws(
    () => observationReadOptions({ cursor: "x", full: true }),
    /immutable capture/,
  );
  assert.throws(
    () => observationReadOptions({ baseObservationId: "" }),
    /nonempty/,
  );
  assert.throws(() => observationReadOptions({ full: "true" }), /boolean/);
  assert.deepEqual(observationReadOptions({ full: true }), { full: true });
});

test("cursor freshness probes use the current caller's cancellation signal", async () => {
  const p = presenter(2);
  const controller = new AbortController();
  const c = capture(1, 4, "");
  let received: AbortSignal | undefined;
  c.assertCurrent = (signal) => {
    received = signal;
    return new Promise<void>((_resolve, reject) =>
      signal!.addEventListener("abort", () => reject(signal!.reason), {
        once: true,
      }),
    );
  };
  const first = publish(p, "one", c);
  const pending = p.read("owner/tab", first.nextCursor, controller.signal);
  controller.abort(new Error("current read cancelled"));
  await assert.rejects(pending, /current read cancelled/);
  assert.equal(received, controller.signal);
  await assert.rejects(p.read("owner/tab", first.nextCursor), /consumed/);
});
