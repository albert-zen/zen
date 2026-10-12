import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ZenXTriggersCapabilityPackage } from "../src/main/capabilities/automation-control-package.js";

test("published Triggers manifest matches Host tools, commands and navigation contributions", async () => {
  const packaged = JSON.parse(
    await readFile(
      new URL(
        "../../../packages/zenx-triggers-plugin/zenx.plugin.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const runtime = new ZenXTriggersCapabilityPackage({} as never).manifest;
  assert.deepEqual(packaged.tools, runtime.tools);
  for (const name of ["commands", "pages", "sidebar"] as const)
    assert.deepEqual(
      packaged.contributions[name],
      runtime.contributions?.[name],
    );
});
