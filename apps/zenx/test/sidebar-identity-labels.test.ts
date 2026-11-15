import assert from "node:assert/strict";
import test from "node:test";
import { sidebarIdentityCases } from "../scripts/sidebar-identity-cases.mjs";
import { sidebarChildTitlePlans } from "../src/renderer/src/sidebar-title-labels.js";

test("fixed identity cases preserve exact product suffixes without invented names", () => {
  for (const [key, c] of Object.entries(sidebarIdentityCases)) {
    const plans = sidebarChildTitlePlans([
      { id: "a", title: c.title, parentId: "p" },
      { id: "b", title: c.siblingTitle, parentId: "p" },
    ]);
    for (const [id, plan] of plans) {
      const original = id === "a" ? c.title : c.siblingTitle;
      assert(plan.bare && original.endsWith(plan.bare));
      assert.equal(plan.marked, "\u2026 " + plan.bare);
    }
    assert.equal(plans.size, key.endsWith("extension") ? 1 : 2);
  }
});
