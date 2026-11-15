import assert from "node:assert/strict";
import test from "node:test";
import { sidebarChildTitlePlans } from "../src/renderer/src/sidebar-title-labels.js";
import { restingLabelFitMode } from "../src/renderer/src/workspace-resting-labels.js";
const title =
  "Design review · shared component accessibility and release readiness";
const rows = [
  { id: "a", title, parentId: "parent" },
  { id: "b", title: `${title} · alternate review`, parentId: "parent" },
] as const;
test("prefix-extension pair preserves canonical first title and identifies only its sibling", () => {
  const plans = sidebarChildTitlePlans(rows);
  assert.equal(plans.size, 1);
  assert.deepEqual(plans.get("b"), {
    marked: "… alternate review",
    bare: "alternate review",
  });
  assert.deepEqual(rows[0], { id: "a", title, parentId: "parent" });
});
test("ordinary rows, unrelated names, different parents, duplicate full names do not abbreviate", () => {
  assert.equal(
    sidebarChildTitlePlans(rows.map(({ parentId, ...row }) => row)).size,
    0,
  );
  assert.equal(
    sidebarChildTitlePlans([{ ...rows[0] }, { ...rows[1], parentId: "other" }])
      .size,
    0,
  );
  assert.equal(
    sidebarChildTitlePlans([{ ...rows[0] }, { ...rows[1], title }]).size,
    0,
  );
  assert.equal(
    sidebarChildTitlePlans([
      { ...rows[0] },
      { ...rows[1], title: "Other task" },
    ]).size,
    0,
  );
});
test("suffix candidates cannot collide with ordinary canonical titles", () => {
  assert.equal(
    sidebarChildTitlePlans([...rows, { id: "c", title: "… alternate review" }])
      .size,
    0,
  );
  assert.deepEqual(
    sidebarChildTitlePlans([
      ...rows,
      { id: "c", title: "alternate review" },
    ]).get("b"),
    undefined,
  );
});
test("CJK/emoji names remain grapheme-safe exact suffixes", () => {
  const names = [
    "共同任务上下文与设计审查最终交付👩‍💻甲",
    "共同任务上下文与设计审查最终交付👩‍💻乙",
  ];
  const plans = sidebarChildTitlePlans(
    names.map((title, i) => ({ id: String(i), title, parentId: "p" })),
  );
  assert.equal(plans.size, 2);
  for (const [id, plan] of plans) {
    const name = names[Number(id)];
    assert(name !== undefined, "Plan references an existing fixture name");
    assert(name.endsWith(plan.bare!));
    assert(!plan.bare!.includes("\udcbb"));
  }
});
test("existing Room fit contract requires real overflow, desktop, and fully fitting suffix", () => {
  assert.equal(
    restingLabelFitMode({
      desktop: true,
      available: 90,
      full: 400,
      marked: 70,
      bare: 50,
    }),
    "marked",
  );
  assert.equal(
    restingLabelFitMode({
      desktop: true,
      available: 60,
      full: 400,
      marked: 70,
      bare: 50,
    }),
    "bare",
  );
  assert.equal(
    restingLabelFitMode({
      desktop: true,
      available: 40,
      full: 400,
      marked: 70,
      bare: 50,
    }),
    "canonical",
  );
  assert.equal(
    restingLabelFitMode({
      desktop: true,
      available: 500,
      full: 400,
      marked: 70,
      bare: 50,
    }),
    "canonical",
  );
  assert.equal(
    restingLabelFitMode({
      desktop: false,
      available: 90,
      full: 400,
      marked: 70,
      bare: 50,
    }),
    "canonical",
  );
  assert.equal(
    restingLabelFitMode({
      desktop: true,
      available: 0,
      full: 400,
      marked: 70,
      bare: 50,
    }),
    "canonical",
  );
});

test("different sibling groups cannot introduce colliding labels in Recent", () => {
  const extra = rows.map((row) => ({
    ...row,
    id: row.id + "2",
    title: row.title.replace("Design review", "System review"),
    parentId: "parent2",
  }));
  assert.equal(sidebarChildTitlePlans([...rows, ...extra]).size, 0);
});

test("explicit extension retains entire distinction or abstains without fit", () => {
  const plan = sidebarChildTitlePlans(rows).get("b")!;
  assert.equal(plan.bare, "alternate review");
  assert.equal(
    restingLabelFitMode({
      desktop: true,
      available: 200,
      full: 600,
      marked: 150,
      bare: 135,
    }),
    "marked",
  );
  assert.equal(
    restingLabelFitMode({
      desktop: true,
      available: 140,
      full: 600,
      marked: 150,
      bare: 135,
    }),
    "bare",
  );
  assert.equal(
    restingLabelFitMode({
      desktop: true,
      available: 100,
      full: 600,
      marked: 150,
      bare: 135,
    }),
    "canonical",
  );
  assert.equal(
    sidebarChildTitlePlans([
      ...rows,
      { id: "other", title: "Other task · alternate review" },
    ]).has("b"),
    false,
  );
});
