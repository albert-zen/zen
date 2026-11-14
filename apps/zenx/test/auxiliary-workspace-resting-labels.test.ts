import test from "node:test";
import assert from "node:assert/strict";
import { restingConversationLabels as labels } from "../src/renderer/src/workspace-resting-labels.js";
const prefix =
  "Cross-project implementation consistency and detailed interaction validation - ";
const tabs = (values: string[]) =>
  values.map((title, index) => ({ id: `thread:${index}`, title }));
const run = (values: string[], desktop = true) => {
  const input = tabs(values);
  const before = structuredClone(input);
  const output = labels(input, new Set(input.map((x) => x.id)), desktop);
  assert.deepEqual(input, before);
  return [...output.values()];
};
test("retains actual distinguishing suffix and canonical inputs", () => {
  assert.deepEqual(run([prefix + "Alpha", prefix + "Beta"]), [
    "… Alpha",
    "… Beta",
  ]);
});
test("crowded labels are unique and order independent", () => {
  const values = [
    "Alpha",
    "Beta",
    "Alpha · Gamma",
    "Alpha · Delta",
    "Alpha · Epsilon",
  ].map((x) => prefix + x);
  const forward = run(values);
  assert.equal(new Set(forward).size, 5);
  assert.deepEqual(run([...values].reverse()).reverse(), forward);
});
test("Chinese suffixes preserve real characters", () => {
  assert.deepEqual(
    run([
      "跨项目实施一致性与详细交互验证甲组",
      "跨项目实施一致性与详细交互验证乙组",
    ]),
    ["… 甲组", "… 乙组"],
  );
});
test("grapheme clusters are not split", () => {
  assert.deepEqual(run([prefix + "👩🏽‍💻", prefix + "👨🏽‍💻"]), ["… 👩🏽‍💻", "… 👨🏽‍💻"]);
  assert.deepEqual(run([prefix + "e\u0301", prefix + "e\u0300"]), [
    "… e\u0301",
    "… e\u0300",
  ]);
});
test("duplicates, short/unrelated names and narrow UI retain originals", () => {
  for (const values of [
    [prefix + "Alpha", prefix + "Alpha"],
    ["Alpha", "Beta"],
    ["Different beginning long title", "Another beginning long title"],
  ])
    assert.deepEqual(run(values), values);
  const values = [prefix + "Alpha", prefix + "Beta"];
  assert.deepEqual(run(values, false), values);
});
test("non-conversations and nonoverflowing conversations stay unchanged", () => {
  const file = { id: "file:0", title: prefix + "Alpha" };
  const input = [
    file,
    { id: "thread:0", title: prefix + "Alpha" },
    { id: "thread:1", title: prefix + "Beta" },
  ];
  assert.deepEqual(
    [...labels(input, new Set()).values()],
    input.map((x) => x.title),
  );
  assert.equal(
    labels(input, new Set(input.map((x) => x.id))).get(file.id),
    file.title,
  );
});
test("rename recomputes without retaining stale labels", () => {
  assert.deepEqual(run([prefix + "Alpha", "A new task"]), [
    prefix + "Alpha",
    "A new task",
  ]);
});

test("natural trailing segments distinguish crowded titles", () => {
  assert.deepEqual(
    run(
      [
        "Alpha",
        "Beta",
        "Alpha · Gamma",
        "Alpha · Delta",
        "Alpha · Epsilon",
      ].map((value) => prefix + value),
    ),
    ["… Alpha", "… Beta", "… Gamma", "… Delta", "… Epsilon"],
  );
});
test("normalized duplicate titles never become order dependent", () => {
  for (const endings of [
    ["Alpha", " Alpha", "Beta"],
    ["é", "e\u0301", "Beta"],
    ["ALPHA", "Alpha", "Beta"],
  ]) {
    const input = endings.map((value) => prefix + value);
    const output = run(input);
    assert.equal(output[0], input[0]);
    assert.equal(output[1], input[1]);
    assert.deepEqual(run([...input].reverse()).reverse(), output);
  }
});
test("canonical label collisions are rejected globally", () => {
  const values = [prefix + "Alpha", prefix + "Beta", "… Alpha"];
  assert.equal(run(values)[0], values[0]);
  assert.deepEqual(run([...values].reverse()).reverse(), run(values));
});

import {
  restingConversationLabelPlans as plans,
  restingLabelFitMode as fit,
} from "../src/renderer/src/workspace-resting-labels.js";

test("marked then genuine bare suffix and then canonical width fallback", () => {
  const input = tabs([prefix + "Alpha", prefix + "Beta"]);
  assert.deepEqual(
    plans(input, new Set(input.map((x) => x.id))).get("thread:0"),
    { marked: "… Alpha", bare: "Alpha" },
  );
  const measurements = {
    desktop: true,
    available: 43,
    full: 500,
    marked: 48,
    bare: 32,
  };
  assert.equal(fit(measurements), "bare");
  assert.equal(fit({ ...measurements, available: 48 }), "marked");
  assert.equal(fit({ ...measurements, available: 31 }), "canonical");
  assert.equal(fit({ ...measurements, desktop: false }), "canonical");
  assert.equal(fit({ ...measurements, full: 43 }), "canonical");
  assert.equal(fit({ ...measurements, bare: undefined }), "canonical");
  for (const invalid of [0, -1, NaN, Infinity])
    assert.equal(
      fit({ ...measurements, marked: invalid, bare: invalid }),
      "canonical",
    );
});
test("canonical literal ellipsis never creates bare abbreviation", () => {
  const input = tabs(["… Alpha", "… Beta"]);
  assert.deepEqual(
    plans(input, new Set(input.map((x) => x.id))).get("thread:0"),
    { marked: "… Alpha", bare: undefined },
  );
});
test("every allowed presentation is collision-free against every other plan and canonical", () => {
  const normalize = (s: string) =>
    s.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
  const cases = [
    [
      prefix + "Alpha",
      prefix + "Beta",
      prefix + "Alpha · Gamma",
      prefix + "Alpha · Delta",
      prefix + "Alpha · Epsilon",
    ],
    [prefix + "Alpha", prefix + "Beta", "Alpha"],
    [prefix + "Alpha", prefix + "Beta", "… Alpha"],
    [prefix + "Alpha", prefix + "Beta", prefix + "… Alpha"],
    [prefix + "é", prefix + "e\u0301", prefix + "Beta"],
    [prefix + "Alpha", prefix + " Alpha", prefix + "Beta"],
    [prefix + "Ａlpha", prefix + "Alpha", prefix + "Beta"],
  ];
  for (const values of cases) {
    const input = tabs(values);
    input.push({ id: "file:collision", title: "… Gamma" });
    const output = plans(input, new Set(input.map((x) => x.id)));
    const reverse = plans(
      [...input].reverse(),
      new Set(input.map((x) => x.id)),
    );
    for (const tab of input) {
      const own = output.get(tab.id)!;
      assert.deepEqual(own, reverse.get(tab.id));
      if (own.bare) assert.ok(tab.title.endsWith(own.bare));
      for (const form of [
        own.marked === tab.title ? undefined : own.marked,
        own.bare,
      ]) {
        if (form === undefined) continue;
        for (const peer of input.filter((x) => x.id !== tab.id)) {
          const other = output.get(peer.id)!;
          for (const reserved of [peer.title, other.marked, other.bare])
            if (reserved !== undefined)
              assert.notEqual(normalize(form), normalize(reserved));
        }
      }
    }
  }
});
