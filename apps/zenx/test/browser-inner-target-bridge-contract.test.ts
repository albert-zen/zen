import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

test("closed-root evidence uses the existing bounded tab command surface", async () => {
  const source = await readFile(
    new URL("../src/main/chrome-extension-bridge.ts", import.meta.url),
    "utf8",
  );
  const parsed = ts.createSourceFile(
    "bridge.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const methods: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(parsed) === "ALLOWED_TAB_COMMANDS"
    ) {
      assert.ok(node.initializer && ts.isNewExpression(node.initializer));
      const argument = node.initializer.arguments?.[0];
      assert.ok(argument && ts.isArrayLiteralExpression(argument));
      for (const item of argument.elements) {
        assert.ok(ts.isStringLiteral(item));
        methods.push(item.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  for (const method of [
    "DOM.describeNode",
    "DOM.resolveNode",
    "Runtime.callFunctionOn",
    "Runtime.releaseObject",
  ])
    assert.ok(methods.includes(method), method);
  assert.ok(
    !methods.some((method) => method.startsWith("Target.")),
    "Root evidence must not grant arbitrary child-target routing",
  );
  assert.ok(
    !methods.includes("DOM.getDocument"),
    "Do not replace bounded exact-node evidence with an unbounded document traversal",
  );
  assert.ok(
    source.indexOf("session?.socket !== socket") >= 0 &&
      source.indexOf("session?.socket !== socket") <
        source.indexOf("!ALLOWED_TAB_COMMANDS.has(method)"),
    "The existing socket/session/tab fence still precedes command forwarding",
  );
});

test("packaged Browser pointer/key descriptions match the selected providers", async () => {
  const { browserCapabilityManifest } =
    await import("../src/main/capabilities/browser-provider.js");
  const { concurrentBrowserManifest, multiBrowserManifest } =
    await import("../src/main/capabilities/browser-backend-registry.js");
  const { userBrowserManifest } =
    await import("../src/main/capabilities/provider-catalog.js");
  for (const [file, manifest] of [
    ["zenx.plugin.json", browserCapabilityManifest],
    ["variants/concurrent.zenx.plugin.json", concurrentBrowserManifest()],
    ["variants/multi.zenx.plugin.json", multiBrowserManifest()],
    ["variants/user-session.zenx.plugin.json", userBrowserManifest()],
  ] as const) {
    const packaged = JSON.parse(
      await readFile(
        new URL(
          `../../../packages/zenx-browser-plugin/${file}`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
    for (const tool of manifest.tools.filter((tool) =>
      /_(pointer_click|key_press)$/.test(tool.name),
    )) {
      assert.equal(
        packaged.tools.find((item: { name: string }) => item.name === tool.name)
          ?.description,
        tool.description,
        `${file}: ${tool.name}`,
      );
    }
  }
});
