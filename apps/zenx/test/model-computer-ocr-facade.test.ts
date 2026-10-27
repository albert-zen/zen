import assert from "node:assert/strict";
import test from "node:test";
import { ModelReferenceRegistry } from "../../../src/model-references.js";
import {
  computerModelDefinition,
  decodeComputerArguments,
  isComputerModelTool,
  projectComputerResult,
} from "../src/main/capabilities/model-computer-facade.js";

const target = { pid: 7, windowTitle: "工作消息" };
const epoch = "native-generation";
const screenshot = {
  bindingId: "binding-native",
  captureId: "capture-native",
  capturedAt: "2026-01-01T01:00:00.000Z",
  target,
};

test("OCR model schema exposes only the exact screenshot ref and optional languages", () => {
  assert.equal(isComputerModelTool("computer_ocr"), true);
  const definition = computerModelDefinition({
    name: "computer_ocr",
    description: "native OCR",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "object" },
        captureId: { type: "string" },
        languages: { type: "array", items: { type: "string" } },
      },
      required: ["target", "captureId"],
      additionalProperties: false,
    },
  });
  assert.deepEqual(Object.keys(definition.inputSchema.properties).sort(), [
    "capture",
    "languages",
  ]);
  assert.deepEqual(definition.inputSchema.required, ["capture"]);
});

test("OCR ref restores original target/capture, not a newer screenshot or caller replacement", () => {
  const refs = new ModelReferenceRegistry().scope("owner");
  const old = projectComputerResult(screenshot, { target }, refs, epoch);
  projectComputerResult(
    { ...screenshot, bindingId: "new-binding", captureId: "new-capture" },
    { target: { ...target, windowTitle: "Other" } },
    refs,
    epoch,
  );
  const args = decodeComputerArguments(
    "computer_ocr",
    { capture: old.capture, languages: ["zh-Hans"] },
    refs,
    epoch,
  );
  assert.deepEqual(args, {
    target,
    captureId: screenshot.captureId,
    languages: ["zh-Hans"],
  });
  assert.throws(
    () =>
      decodeComputerArguments(
        "computer_ocr",
        { capture: old.capture, target: { pid: 8 } },
        refs,
        epoch,
      ),
    /omit target and binding/,
  );
  assert.throws(
    () =>
      decodeComputerArguments(
        "computer_ocr",
        { captureId: screenshot.captureId, target },
        refs,
        epoch,
      ),
    /compact Computer reference/,
  );
  assert.throws(
    () =>
      decodeComputerArguments(
        "computer_ocr",
        { capture: old.capture },
        refs,
        "retired-generation",
      ),
    /reference|retired|scope/iu,
  );
  const other = new ModelReferenceRegistry().scope("other-owner");
  assert.throws(
    () =>
      decodeComputerArguments(
        "computer_ocr",
        { capture: old.capture },
        other,
        epoch,
      ),
    /reference|unknown|scope/iu,
  );
});

test("old capture refs without target fail refresh; clicks keep their original native pair", () => {
  const refs = new ModelReferenceRegistry().scope("owner");
  const old = refs.bind(
    "computer",
    "capture",
    { bindingId: screenshot.bindingId, captureId: screenshot.captureId },
    epoch,
  );
  assert.throws(
    () =>
      decodeComputerArguments("computer_ocr", { capture: old }, refs, epoch),
    /fresh screenshot/,
  );
  assert.deepEqual(
    decodeComputerArguments(
      "computer_foreground_click",
      { capture: old, x: 20, y: 40 },
      refs,
      epoch,
    ),
    {
      bindingId: screenshot.bindingId,
      captureId: screenshot.captureId,
      x: 20,
      y: 40,
    },
  );
});

test("OCR result keeps original capture ref and literal text without minting controls", () => {
  const refs = new ModelReferenceRegistry().scope("owner");
  const prior = projectComputerResult(screenshot, { target }, refs, epoch);
  const texts = [
    {
      text: "工作消息 r999 capture-native /tmp/unchanged.png",
      confidence: 0.9,
      box: { x: 20, y: 40, width: 200, height: 50 },
    },
  ];
  const result = projectComputerResult(
    { ...screenshot, texts, observationOnly: true },
    { target, captureId: screenshot.captureId },
    refs,
    epoch,
  );
  assert.equal(result.capture, prior.capture);
  assert.deepEqual(result.texts, texts);
  assert.equal(result.controls, undefined);
  assert.equal(result.capturedAt, screenshot.capturedAt);
  assert.equal(result.captureId, undefined);
});
