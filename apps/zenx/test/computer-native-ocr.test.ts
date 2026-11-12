import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  COMPUTER_OCR_BUDGET_MS,
  computerOcrLanguages,
  MAC_OCR_SOURCE,
  parseComputerOcrRecognition,
} from "../src/main/capabilities/computer-ocr.js";
import { runProcess } from "../src/main/capabilities/computer-provider.js";

// Actual OS Vision on a disposable bitmap, not mocked OCR, AX or a real account.
// The 1600x1000 image represents an 800x500 logical window at 2x scale.
const FIXTURE_SOURCE = `import AppKit
let destination = CommandLine.arguments[1]
let large = CommandLine.arguments.contains("large")
let factor = large ? 2 : 1
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1600 * factor, pixelsHigh: 1000 * factor,
  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
let context = NSGraphicsContext.current!.cgContext
context.setFillColor(NSColor.white.cgColor)
context.fill(CGRect(x: 0, y: 0, width: 1600 * factor, height: 1000 * factor))
if CommandLine.arguments.count < 3 || large {
  context.scaleBy(x: CGFloat(2 * factor), y: CGFloat(2 * factor))
  let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 32), .foregroundColor: NSColor.black]
  ("HELLO OCR" as NSString).draw(at: NSPoint(x: 40, y: 390), withAttributes: attributes)
  ("工作消息" as NSString).draw(at: NSPoint(x: 40, y: 290), withAttributes: attributes)
}
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: destination))
`;

test(
  "actual macOS Vision recognizes synthetic English/CJK at 2x image coordinates; rejects unsupported/mismatched reads",
  { skip: process.platform !== "darwin", timeout: 120_000 },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-native-ocr-"));
    const image = { width: 1600, height: 1000 };
    const languages = computerOcrLanguages(undefined);
    try {
      const source = path.join(directory, "ocr.swift");
      const executable = path.join(directory, "ocr");
      await writeFile(source, MAC_OCR_SOURCE);
      const target = `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos12.0`;
      await runProcess(
        "/usr/bin/swiftc",
        ["-O", "-target", target, source, "-o", executable],
        60_000,
      );
      const metadata = await runProcess(
        "/usr/bin/vtool",
        ["-show-build", executable],
        10_000,
      );
      assert.match(metadata, /platform MACOS/u);
      assert.match(metadata, /minos 12\.0/u);
      const fixture = path.join(directory, "fixture.swift");
      const fixtureExecutable = path.join(directory, "fixture");
      await writeFile(fixture, FIXTURE_SOURCE);
      await runProcess(
        "/usr/bin/swiftc",
        [fixture, "-o", fixtureExecutable],
        60_000,
      );
      const imagePath = path.join(directory, "synthetic.png");
      await runProcess(fixtureExecutable, [imagePath], 10_000);
      const bytes = await readFile(imagePath);
      const imageSha256 = createHash("sha256").update(bytes).digest("hex");
      const request = { ...image, imagePath, imageSha256, languages };
      const output = await runProcess(
        executable,
        [],
        COMPUTER_OCR_BUDGET_MS,
        JSON.stringify(request),
      );
      const recognized = parseComputerOcrRecognition(output, image, languages);
      // Preserve actual native output even when a later recognition/geometry
      // assertion fails. This is exclusively the generated fixture, not a screen.
      if (process.env.ZENX_COMPUTER_OCR_EVIDENCE)
        await writeFile(
          process.env.ZENX_COMPUTER_OCR_EVIDENCE,
          JSON.stringify(
            {
              scope: "synthetic bitmap only; no real application acceptance",
              stage: "recognition-returned; assertions not yet complete",
              recognized,
            },
            null,
            2,
          ),
        );
      console.log(
        "Native Vision synthetic recognition:",
        JSON.stringify(recognized),
      );
      const english = recognized.texts.find((text) =>
        text.text.includes("HELLO OCR"),
      );
      const chinese = recognized.texts.find((text) =>
        text.text.replace(/\s/gu, "").includes("工作消息"),
      );
      assert.ok(english, "Real Vision must recognize the English fixture");
      assert.ok(
        chinese,
        "Real Vision must recognize the Simplified Chinese fixture",
      );
      for (const [text, top, bottom] of [
        [english, 100, 270],
        [chinese, 300, 470],
      ] as const) {
        assert.ok(
          text.box.x >= 60 && text.box.x <= 120,
          "Boxes use original 2x pixels, not logical points",
        );
        assert.ok(
          text.box.y >= top && text.box.y + text.box.height <= bottom,
          "Vision bottom-left boxes become top-left image pixels",
        );
        assert.ok(text.box.height > 35 && text.box.height < 95);
      }
      assert.equal(recognized.truncated, false);
      const largePath = path.join(directory, "large.png");
      await runProcess(fixtureExecutable, [largePath, "large"], 10_000);
      const largeBytes = await readFile(largePath),
        largeDimensions = { width: 3200, height: 2000 };
      const largeOutput = await runProcess(
        executable,
        [],
        COMPUTER_OCR_BUDGET_MS,
        JSON.stringify({
          ...largeDimensions,
          imagePath: largePath,
          imageSha256: createHash("sha256").update(largeBytes).digest("hex"),
          languages,
        }),
      );
      const large = parseComputerOcrRecognition(
        largeOutput,
        largeDimensions,
        languages,
      );
      console.log(
        "Native Vision large synthetic recognition:",
        JSON.stringify(large),
      );
      if (process.env.ZENX_COMPUTER_OCR_EVIDENCE)
        await writeFile(
          process.env.ZENX_COMPUTER_OCR_EVIDENCE,
          JSON.stringify(
            {
              scope: "synthetic bitmap only",
              stage: "small-and-large-recognition-returned",
              recognized,
              largeRecognized: large,
              imageSha256,
              largeImageSha256: createHash("sha256")
                .update(largeBytes)
                .digest("hex"),
            },
            null,
            2,
          ),
        );
      assert.equal(large.downsampled, true);
      assert.ok(
        large.recognitionSize!.width * large.recognitionSize!.height <=
          4_000_000,
      );
      assert.equal(large.width, 3200);
      assert.equal(large.height, 2000);
      const largeEnglish = large.texts.find((t) =>
        t.text.includes("HELLO OCR"),
      );
      const largeChinese = large.texts.find((t) =>
        t.text.replace(/\s/gu, "").includes("工作消息"),
      );
      assert.ok(largeEnglish);
      assert.ok(largeChinese);
      for (const [text, top, bottom] of [
        [largeEnglish, 200, 540],
        [largeChinese, 600, 940],
      ] as const) {
        assert.ok(
          text.box.x >= 120 && text.box.x <= 240,
          "scaled recognition boxes return original capture pixels",
        );
        assert.ok(text.box.y >= top && text.box.y + text.box.height <= bottom);
        assert.ok(text.box.height > 70 && text.box.height < 190);
      }

      await assert.rejects(
        runProcess(
          executable,
          [],
          COMPUTER_OCR_BUDGET_MS,
          JSON.stringify({ ...request, languages: ["zz-ZZ"] }),
        ),
        /language unavailable/,
      );
      for (const incompatible of [
        ["en-US", "zh-Hans"],
        ["zh-Hans", "fr-FR"],
      ])
        await assert.rejects(
          runProcess(
            executable,
            [],
            COMPUTER_OCR_BUDGET_MS,
            JSON.stringify({ ...request, languages: incompatible }),
          ),
          /Chinese languages first, paired only with en-US/,
        );
      await assert.rejects(
        runProcess(
          executable,
          [],
          COMPUTER_OCR_BUDGET_MS,
          JSON.stringify({ ...request, width: 800 }),
        ),
        /mismatched/,
      );
      await assert.rejects(
        runProcess(
          executable,
          [],
          COMPUTER_OCR_BUDGET_MS,
          JSON.stringify({ ...request, imageSha256: "0".repeat(64) }),
        ),
        /mismatched/,
      );
      await assert.rejects(
        runProcess(
          executable,
          [],
          COMPUTER_OCR_BUDGET_MS,
          JSON.stringify(request),
          AbortSignal.timeout(1),
        ),
        /timeout/iu,
      );
      await runProcess(fixtureExecutable, [imagePath, "blank"], 10_000);
      const blankHash = createHash("sha256")
        .update(await readFile(imagePath))
        .digest("hex");
      const blank = await runProcess(
        executable,
        [],
        COMPUTER_OCR_BUDGET_MS,
        JSON.stringify({ ...request, imageSha256: blankHash }),
      );
      assert.deepEqual(
        parseComputerOcrRecognition(blank, image, languages).texts,
        [],
      );
      if (process.env.ZENX_COMPUTER_OCR_EVIDENCE)
        await writeFile(
          process.env.ZENX_COMPUTER_OCR_EVIDENCE,
          JSON.stringify(
            {
              scope: "synthetic bitmap only; no real application acceptance",
              deploymentTarget: "macOS 12.0",
              logicalWindow: { width: 800, height: 500 },
              recognized,
              largeRecognized: large,
              sourceImageSha256: imageSha256,
              largeImageSha256: createHash("sha256")
                .update(largeBytes)
                .digest("hex"),
              checks: [
                "english",
                "simplified-chinese",
                "2x-geometry",
                "6.4MP-source-with-recognition-under-4MP",
                "large-original-pixel-boxes",
                "empty",
                "unsupported-language",
                "unsupported-language-combination",
                "dimension-mismatch",
                "capture-digest-mismatch",
                "cancelled-read",
              ],
            },
            null,
            2,
          ),
        );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
