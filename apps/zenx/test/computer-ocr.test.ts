import assert from "node:assert/strict";
import test from "node:test";
import {
  computerOcrLanguages,
  parseComputerOcrRecognition,
} from "../src/main/capabilities/computer-ocr.js";

const image = { width: 800, height: 400 };
const languages = ["zh-Hans", "en-US"];
const result = () => ({
  ...image,
  engine: "apple-vision",
  revision: 2,
  languages,
  texts: [
    {
      text: "工作消息 Hello",
      confidence: 0.9,
      box: { x: 10, y: 40, width: 280, height: 30 },
    },
  ],
  truncated: false,
});

test("OCR preserves observed CJK, confidence and image-pixel geometry without action fields", () => {
  const raw = result();
  Object.assign(raw.texts[0]!, {
    selector: { targetId: "fake" },
    actions: ["press"],
  });
  const parsed = parseComputerOcrRecognition(
    JSON.stringify(raw),
    image,
    languages,
  );
  assert.deepEqual(parsed.texts, result().texts);
  assert.equal(parsed.truncated, false);
});

test("OCR empty pixels are an empty observation, not AX controls or an unavailable engine", () => {
  const raw = { ...result(), texts: [] };
  assert.deepEqual(
    parseComputerOcrRecognition(JSON.stringify(raw), image, languages).texts,
    [],
  );
});

test("OCR bounds and capture geometry mismatches fail explicitly", () => {
  assert.throws(
    () =>
      parseComputerOcrRecognition(
        JSON.stringify(result()),
        { ...image, width: 700 },
        languages,
      ),
    /captured image/,
  );
  const outside = result();
  outside.texts[0]!.box.x = 790;
  assert.throws(
    () =>
      parseComputerOcrRecognition(JSON.stringify(outside), image, languages),
    /geometry/,
  );
  const oversized = result();
  oversized.texts[0]!.text = "中".repeat(6000);
  assert.throws(
    () =>
      parseComputerOcrRecognition(JSON.stringify(oversized), image, languages),
    /bounded output/,
  );
  const overflow = {
    ...result(),
    texts: Array.from({ length: 97 }, () => result().texts[0]),
  };
  assert.throws(
    () =>
      parseComputerOcrRecognition(JSON.stringify(overflow), image, languages),
    /captured image/,
  );
});

test("OCR language requests are explicit and bounded", () => {
  assert.deepEqual(computerOcrLanguages(undefined), languages);
  assert.deepEqual(computerOcrLanguages(["zh-Hant", "en-US"]), [
    "zh-Hant",
    "en-US",
  ]);
  for (const invalid of [
    [],
    ["en-US", "en-US"],
    [""],
    "en-US",
    ["en-US", "zh-Hans", "zh-Hant", "ja-JP", "ko-KR"],
  ])
    assert.throws(() => computerOcrLanguages(invalid), /1–4 distinct/);
});

test("native-only OCR schema is read-only and unavailable providers never inspect or mutate", async () => {
  const {
    ComputerZenXCapabilityPackage,
    boundComputerCapabilityManifest,
    computerCapabilityManifest,
  } = await import("../src/main/capabilities/computer-provider.js");
  const tool = boundComputerCapabilityManifest.tools.find(
    (entry) => entry.name === "computer_ocr",
  )!;
  assert.equal(tool.interactionMode, "background_safe");
  assert.deepEqual(tool.permissions, ["computer.window.capture"]);
  assert.equal(
    computerCapabilityManifest.tools.some(
      (entry) => entry.name === "computer_ocr",
    ),
    false,
  );
  let dispatches = 0;
  const unsupported = async (): Promise<never> => {
    dispatches++;
    throw Error("must not dispatch");
  };
  const backend = {
    inspect: unsupported,
    press: unsupported,
    setValue: unsupported,
    screenshot: unsupported,
    foregroundClick: unsupported,
    foregroundKeyPress: unsupported,
    foregroundScroll: unsupported,
    close: async () => {},
  };
  const capability = new ComputerZenXCapabilityPackage(backend);
  await assert.rejects(
    capability.invoke("computer_ocr", {
      callId: "ocr",
      name: "computer_ocr",
      arguments: {
        target: { pid: 7, windowTitle: "Window" },
        captureId: "synthetic",
      },
      cwd: "/",
      threadId: "owner",
      signal: new AbortController().signal,
    }),
    /unavailable for this Computer provider/,
  );
  assert.equal(dispatches, 0);
  await capability.close();
});

test("Vision Chinese/English tags normalize without dropping languages; impossible combinations fail", () => {
  assert.deepEqual(computerOcrLanguages(["en-US", "zh-Hans"]), [
    "zh-Hans",
    "en-US",
  ]);
  assert.deepEqual(computerOcrLanguages(["zh-Hant", "en-US", "zh-Hans"]), [
    "zh-Hant",
    "zh-Hans",
    "en-US",
  ]);
  assert.deepEqual(computerOcrLanguages(["en-US", "fr-FR"]), [
    "en-US",
    "fr-FR",
  ]);
  assert.throws(
    () => computerOcrLanguages(["zh-Hans", "fr-FR"]),
    /cannot combine Chinese/,
  );
});

test("bounded OCR processing metadata preserves original coordinates and rejects oversized recognition surfaces", () => {
  const raw = {
    ...result(),
    recognitionSize: { width: 400, height: 200 },
    downsampled: true,
  };
  const parsed = parseComputerOcrRecognition(
    JSON.stringify(raw),
    image,
    languages,
  );
  assert.deepEqual(parsed.recognitionSize, { width: 400, height: 200 });
  assert.equal(parsed.downsampled, true);
  assert.deepEqual(parsed.texts, raw.texts);
  assert.equal(parsed.width, 800);
  for (const changed of [
    { recognitionSize: { width: 801, height: 400 } },
    { downsampled: false },
    { recognitionSize: { width: 0, height: 200 } },
  ])
    assert.throws(
      () =>
        parseComputerOcrRecognition(
          JSON.stringify({ ...raw, ...changed }),
          image,
          languages,
        ),
      /recognition image/,
    );
});
