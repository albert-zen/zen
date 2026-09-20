import assert from "node:assert/strict";
import test from "node:test";
import { publishComponent } from "../../../examples/cockpit-component/publish.mjs";

test("publisher preserves arbitrary authored content exactly, without executing or templating it", () => {
  for (const html of [
    "<h2>Evidence A</h2>",
    "<script>throw new Error('must not run in Host')</script><button>Alternative B</button>",
  ]) {
    const result = publishComponent({
      title: "Evidence",
      html,
      sourceItemIds: ["source"],
    });
    assert.equal(result.structuredContent.html, html);
    assert.equal(result.contentType, "cockpit-component/card");
  }
  assert.throws(
    () =>
      publishComponent({
        title: "Evidence",
        html: "字".repeat(8193),
        sourceItemIds: ["source"],
      }),
    /24 KiB/,
  );
  assert.throws(
    () =>
      publishComponent({
        title: "Evidence",
        html: "<p>Empty sources</p>",
        sourceItemIds: [],
      }),
    /Item IDs/,
  );
});
