import assert from "node:assert/strict";
import test from "node:test";
import { computerObjectBinding } from "../../../packages/zenx-computer-plugin/src/object-contract.js";
import {
  computerModelDefinition,
  decodeComputerArguments,
  projectComputerResult,
} from "../src/main/capabilities/model-computer-facade.js";
import { ModelReferenceRegistry } from "../../../src/model-references.js";

const provider = "macos-desktop";
const descriptor = (name: string, properties = {}) =>
  computerObjectBinding(name, provider, { properties });

test("Computer object discovery describes exact references and explicit app-current-focus scope", () => {
  assert.deepEqual(descriptor("computer_inspect"), {
    kind: "computer",
    provider,
    path: ["inspect"],
    reference: { kind: "window", argument: "target" },
  });
  assert.deepEqual(descriptor("computer_background_type")?.reference, {
    kind: "appCurrentFocus",
    argument: "binding",
  });
  assert.deepEqual(descriptor("computer_background_click")?.reference, {
    kind: "capture",
    argument: "capture",
  });
  assert.deepEqual(descriptor("computer_ocr")?.path, [
    "extensions",
    "vision",
    "ocr",
  ]);
  for (const name of [
    "computer_paste",
    "computer_drag",
    "computer_select_text",
    "unrelated_tool",
    "constructor",
    "__proto__",
  ])
    assert.equal(
      descriptor(name),
      undefined,
      "unsupported methods must not be invented",
    );
});

test("legacy foreground providers never acquire an exact-window binding claim", () => {
  assert.deepEqual(descriptor("computer_foreground_click")?.path, [
    "foreground",
    "click",
  ]);
  assert.equal(descriptor("computer_foreground_click")?.reference, undefined);
  assert.deepEqual(
    descriptor("computer_foreground_click", { bindingId: {}, captureId: {} })
      ?.reference,
    { kind: "capture", argument: "capture" },
  );
  assert.deepEqual(
    descriptor("computer_foreground_type", { bindingId: {} })?.reference,
    { kind: "binding", argument: "binding" },
  );
});

test("object metadata survives model schema projection without changing native reference checks", () => {
  const objectBinding = descriptor("computer_inspect")!;
  const tool = computerModelDefinition({
    name: "computer_inspect",
    description: "Inspect",
    inputSchema: { type: "object", properties: { target: { type: "object" } } },
    objectBinding,
  });
  assert.deepEqual(tool.objectBinding, objectBinding);
  const registry = new ModelReferenceRegistry();
  const refs = registry.scope("thread-a");
  const target = { pid: 88, windowTitle: "Synthetic" };
  const listed = projectComputerResult(
    { windows: [{ target, applicationName: "Fixture" }] },
    {},
    refs,
    "epoch",
  );
  const ref = (listed.windows as Array<{ ref: string }>)[0]!.ref;
  // Fresh JavaScript facades retain only a short ref; the Host remains the owner.
  assert.deepEqual(
    decodeComputerArguments(
      "computer_inspect",
      { target: ref },
      registry.scope("thread-a"),
      "epoch",
    ),
    { target, full: true },
  );
  assert.throws(
    () =>
      decodeComputerArguments(
        "computer_inspect",
        { target: ref },
        registry.scope("thread-b"),
        "epoch",
      ),
    /reference|retired/i,
  );
  assert.throws(
    () =>
      decodeComputerArguments(
        "computer_inspect",
        { target: ref },
        refs,
        "retired-epoch",
      ),
    /reference|retired/i,
  );
});

test("selection capability observations survive projection without granting or relabeling input scope", () => {
  const refs = new ModelReferenceRegistry().scope("thread");
  const inputCapabilities = {
    availabilityIsSnapshot: true,
    foregroundWindow: {
      available: false,
      scope: "exact_window",
      requires: "matched_ax_window",
    },
    backgroundWindow: {
      available: true,
      scope: "exact_window",
      requires: "fresh_native_capture",
    },
    applicationKeyboard: {
      available: true,
      scope: "application_current_focus",
    },
  };
  const projected = projectComputerResult(
    {
      bindingId: "native-private",
      target: { pid: 88, windowTitle: "Synthetic" },
      inputCapabilities,
    },
    {},
    refs,
    "epoch",
  );
  assert.deepEqual(projected.inputCapabilities, inputCapabilities);
  assert.equal(projected.bindingId, undefined);
  assert.match(projected.binding as string, /^r[1-9][0-9]*$/);
  assert.deepEqual(
    decodeComputerArguments(
      "computer_background_type",
      { binding: projected.binding, text: "Fixture" },
      refs,
      "epoch",
    ),
    { bindingId: "native-private", text: "Fixture" },
  );
  assert.throws(
    () =>
      decodeComputerArguments(
        "computer_background_type",
        { binding: projected.binding, target: { pid: 99 }, text: "Fixture" },
        refs,
        "epoch",
      ),
    /only binding/,
  );
});

test("captured foreground pointer methods require only one exact capture, not duplicate binding", () => {
  for (const name of [
    "computer_foreground_click",
    "computer_foreground_drag",
  ]) {
    const tool = computerModelDefinition({
      name,
      description: name,
      inputSchema: {
        type: "object",
        properties: {
          bindingId: { type: "string" },
          captureId: { type: "string" },
          x: { type: "number" },
          y: { type: "number" },
        },
        required: ["bindingId", "captureId", "x", "y"],
      },
    });
    assert.deepEqual(tool.inputSchema.required, ["capture", "x", "y"]);
    assert.deepEqual(
      computerObjectBinding(name, provider, tool.inputSchema)?.reference,
      { kind: "capture", argument: "capture" },
    );
  }
});

test("packaged provider bindings refer only to actual model-schema fields", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const file of [
    "zenx.plugin.json",
    "variants/win32.zenx.plugin.json",
    "variants/win32-strict.zenx.plugin.json",
    "variants/peekaboo.zenx.plugin.json",
  ]) {
    const manifest = JSON.parse(
      await readFile(
        new URL(
          `../../../packages/zenx-computer-plugin/${file}`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
    for (const native of manifest.tools) {
      const binding = computerObjectBinding(
        native.name,
        manifest.provider.id,
        native.inputSchema,
      );
      if (!binding) continue;
      assert.equal(binding.provider, manifest.provider.id);
      const model = computerModelDefinition(native);
      if (binding.reference) {
        assert.equal(
          Object.hasOwn(
            model.inputSchema.properties,
            binding.reference.argument,
          ),
          true,
          `${file}: ${native.name} reference must exist in actual model schema`,
        );
      }
    }
    if (file !== "zenx.plugin.json") {
      assert.equal(
        manifest.tools.some(
          (tool: { name: string }) => tool.name === "computer_background_type",
        ),
        false,
      );
      assert.equal(
        manifest.tools.some(
          (tool: { name: string }) => tool.name === "computer_ocr",
        ),
        false,
      );
    }
  }
});
