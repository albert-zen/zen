import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validatePluginManifest } from "../dist/index.js";

async function manifest() {
  return JSON.parse(
    await readFile(
      new URL(
        "../../zenx-self-control-plugin/zenx.plugin.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
}

test("plugin authors explicitly opt ordinary background-safe tools into text/JSON targets", async () => {
  const value = await manifest();
  const result = validatePluginManifest(value);
  assert.equal(
    result.tools.find((tool) => tool.name === "zenx_models_list")
      .remoteExecution,
    "text-json",
  );
  assert.equal(
    result.tools.find((tool) => tool.name === "zenx_threads_configure")
      .remoteExecution,
    undefined,
  );
  for (const mode of ["foreground_required", "isolated"]) {
    const invalid = structuredClone(value);
    invalid.tools[0].interactionMode = mode;
    assert.throws(
      () => validatePluginManifest(invalid),
      /remoteExecution.*background_safe/,
    );
  }
  for (const remoteExecution of [true, "media", "background_safe"]) {
    const invalid = structuredClone(value);
    invalid.tools[0].remoteExecution = remoteExecution;
    assert.throws(
      () => validatePluginManifest(invalid),
      /remoteExecution.*text-json/,
    );
  }
});

test("published plugin schema exposes the same bounded opt-in and interaction requirement", async () => {
  const schema = JSON.parse(
    await readFile(
      new URL("../dist/zenx.plugin.schema.json", import.meta.url),
      "utf8",
    ),
  );
  const tool = schema.properties.tools.items;
  assert.equal(tool.properties.remoteExecution.const, "text-json");
  assert.deepEqual(tool.allOf[0].if.required, ["remoteExecution"]);
  assert.equal(
    tool.allOf[0].then.properties.interactionMode.const,
    "background_safe",
  );
});
