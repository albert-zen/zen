import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ZenXSelfControlCapabilityPackage,
  MutableAppServerRequestPort,
} from "../src/main/capabilities/self-control-package.js";

test("both shipped Thread-send schemas and agent-visible instructions make soft guidance the default", async () => {
  const runtime = new ZenXSelfControlCapabilityPackage({
    appServer: new MutableAppServerRequestPort(),
  }).manifest;
  const installed = JSON.parse(
    await readFile(
      new URL(
        "../../../packages/zenx-self-control-plugin/zenx.plugin.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  for (const manifest of [runtime, installed]) {
    const send = manifest.tools.find(
      (tool: { name: string }) => tool.name === "zenx_threads_send",
    )!;
    assert.match(send.description, /Omit messageType.*soft-steer/);
    assert.deepEqual(send.inputSchema.properties.messageType.enum, [
      "guidance",
      "follow_up",
      "replacement",
    ]);
    assert.match(
      send.inputSchema.properties.messageType.description,
      /guidance \(default\)/,
    );
    assert.match(
      send.inputSchema.properties.messageType.description,
      /independently of the manual Composer/,
    );
  }
  assert.match(installed.mainDocument, /omit messageType/);
  const readme = await readFile(
    new URL(
      "../../../packages/zenx-self-control-plugin/README.md",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(readme, /Omit for the saved ZenX/);
  assert.match(readme, /Explicit per-message intent is preserved/);
});
