import assert from "node:assert/strict";
import test from "node:test";
import { toolPresentation } from "../src/renderer/src/tool-presentation.js";

test("known browser and computer operations have readable labels without inventing target content", () => {
  assert.deepEqual(toolPresentation("browser_inspect"), {
    category: "Browser",
    icon: "browser",
    action: "Inspect page",
  });
  assert.equal(toolPresentation("zenx_computer_press").action, "Press element");
  assert.equal(toolPresentation("my_browser_click").action, undefined);
  assert.equal(toolPresentation("browser_unknown").category, "Tool");
  assert.equal(toolPresentation("run_code").category, "Code");
});

test("shell and other built-in tools do not fall back to a generic Tool label", () => {
  assert.deepEqual(toolPresentation("shell"), {
    category: "Shell",
    icon: "terminal",
    action: "Run command",
  });
  assert.equal(toolPresentation("zenx_shell").category, "Shell");
  assert.equal(toolPresentation("wait").category, "Wait");
  assert.equal(toolPresentation("view_image").category, "Image");
});
