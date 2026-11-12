/** Local OCR reads pixels, never creates accessibility controls or action authority. */
export const COMPUTER_OCR_BUDGET_MS = 10_000;
export const COMPUTER_OCR_MAX_BOXES = 96;
export const COMPUTER_OCR_MAX_TEXT_BYTES = 16_384;
export const COMPUTER_OCR_MAX_IMAGE_PIXELS = 16_000_000;
export const COMPUTER_OCR_MAX_RECOGNITION_PIXELS = 4_000_000;
export const COMPUTER_OCR_DEFAULT_LANGUAGES = ["zh-Hans", "en-US"];

export interface ComputerOcrText {
  text: string;
  confidence: number;
  box: { x: number; y: number; width: number; height: number };
}
export interface ComputerOcrRecognition {
  engine: "apple-vision";
  revision: 2;
  languages: string[];
  width: number;
  height: number;
  texts: ComputerOcrText[];
  truncated: boolean;
  recognitionSize?: { width: number; height: number };
  downsampled?: boolean;
}

export function computerOcrLanguages(value: unknown): string[] {
  if (value === undefined) return [...COMPUTER_OCR_DEFAULT_LANGUAGES];
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 4 ||
    value.some(
      (language) =>
        typeof language !== "string" ||
        !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/u.test(language),
    ) ||
    new Set(value).size !== value.length
  )
    throw new Error("OCR languages must contain 1–4 distinct language tags");
  // Vision revision 2 chooses its script recognizer from the first language.
  // Chinese is supported only as the leading group, optionally with English.
  const chinese = (language: string) =>
    language === "zh-Hans" || language === "zh-Hant";
  if (value.some(chinese)) {
    if (value.some((language) => !chinese(language) && language !== "en-US"))
      throw new Error(
        "Vision revision 2 cannot combine Chinese with languages other than en-US; request those languages separately",
      );
    // These are requested language tags, not a priority contract. Preserve every
    // tag while selecting the only model that can recognize the whole set.
    return [
      ...value.filter(chinese),
      ...value.filter((language) => !chinese(language)),
    ];
  }
  return [...value] as string[];
}

/** Check the helper's output against the original image, not current window size. */
export function parseComputerOcrRecognition(
  output: string,
  image: { width: number; height: number },
  languages: string[],
): ComputerOcrRecognition {
  if (Buffer.byteLength(output) > 48 * 1024)
    throw new Error("Native OCR response exceeded its bounded output");
  const result = JSON.parse(output) as ComputerOcrRecognition;
  if (
    !result ||
    result.engine !== "apple-vision" ||
    result.revision !== 2 ||
    result.width !== image.width ||
    result.height !== image.height ||
    JSON.stringify(result.languages) !== JSON.stringify(languages) ||
    typeof result.truncated !== "boolean" ||
    !Array.isArray(result.texts) ||
    result.texts.length > COMPUTER_OCR_MAX_BOXES
  )
    throw new Error("Native OCR response does not match the captured image");
  let textBytes = 0;
  for (const item of result.texts) {
    if (
      !item ||
      typeof item.text !== "string" ||
      !item.text.length ||
      typeof item.confidence !== "number" ||
      !Number.isFinite(item.confidence) ||
      item.confidence < 0 ||
      item.confidence > 1 ||
      !item.box ||
      ![item.box.x, item.box.y, item.box.width, item.box.height].every(
        Number.isFinite,
      ) ||
      item.box.x < 0 ||
      item.box.y < 0 ||
      item.box.width <= 0 ||
      item.box.height <= 0 ||
      item.box.x + item.box.width > image.width + 0.001 ||
      item.box.y + item.box.height > image.height + 0.001
    )
      throw new Error("Native OCR response contains invalid text geometry");
    textBytes += Buffer.byteLength(item.text);
  }
  if (textBytes > COMPUTER_OCR_MAX_TEXT_BYTES)
    throw new Error("Native OCR text exceeded its bounded output");
  const size = result.recognitionSize;
  if (
    (size !== undefined &&
      (!size ||
        !Number.isSafeInteger(size.width) ||
        !Number.isSafeInteger(size.height) ||
        size.width <= 0 ||
        size.height <= 0 ||
        size.width > image.width ||
        size.height > image.height ||
        size.width * size.height > COMPUTER_OCR_MAX_RECOGNITION_PIXELS ||
        result.downsampled !==
          (size.width !== image.width || size.height !== image.height))) ||
    (size === undefined && result.downsampled !== undefined)
  )
    throw new Error("Native OCR recognition image is invalid");
  // Project only observation fields; no selector or action can enter this result.
  return {
    engine: result.engine,
    revision: result.revision,
    languages: [...result.languages],
    width: result.width,
    height: result.height,
    texts: result.texts.map(({ text, confidence, box }) => ({
      text,
      confidence,
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
    })),
    truncated: result.truncated,
    ...(size === undefined
      ? {}
      : {
          recognitionSize: { width: size.width, height: size.height },
          downsampled: result.downsampled,
        }),
  };
}

// Revision 2 deliberately preserves the macOS 12 deployment target. Language
// availability is queried on the running OS; unavailable languages are errors,
// not a silent English-only downgrade. No AppKit, AX, networking or input APIs.
export const MAC_OCR_SOURCE = `import Foundation
import Vision
import ImageIO
import CryptoKit

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\\n").utf8))
  exit(1)
}
let input = FileHandle.standardInput.readDataToEndOfFile()
guard input.count <= 16384,
      let request = try JSONSerialization.jsonObject(with: input) as? [String: Any],
      let imagePath = request["imagePath"] as? String,
      let expectedDigest = request["imageSha256"] as? String,
      let languages = request["languages"] as? [String],
      languages.count >= 1, languages.count <= 4,
      let expectedWidth = request["width"] as? Int,
      let expectedHeight = request["height"] as? Int else {
  fail("Invalid native OCR request")
}
let attributes = try FileManager.default.attributesOfItem(atPath: imagePath)
guard let bytes = attributes[.size] as? NSNumber, bytes.intValue <= 16777216 else {
  fail("OCR image exceeds the byte limit")
}
let imageData = try Data(contentsOf: URL(fileURLWithPath: imagePath))
let digest = SHA256.hash(data: imageData).map { String(format: "%02x", $0) }.joined()
guard imageData.count <= 16777216, digest == expectedDigest,
      let source = CGImageSourceCreateWithData(imageData as CFData, nil),
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      let width = properties[kCGImagePropertyPixelWidth] as? Int,
      let height = properties[kCGImagePropertyPixelHeight] as? Int,
      width > 0, height > 0, width <= 16000000 / height,
      width == expectedWidth, height == expectedHeight else {
  fail("OCR image unavailable, oversized, or mismatched with the original capture")
}
let image: CGImage
if width <= 4000000 / height {
  guard let decoded = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fail("OCR image could not be decoded") }
  image = decoded
} else {
  let scale = sqrt(4000000.0 / (Double(width) * Double(height)))
  let maximum = Int((Double(max(width, height)) * scale).rounded(.down))
  let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: maximum, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceShouldCacheImmediately: false]
  guard maximum > 0, let decoded = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { fail("OCR bounded recognition image unavailable") }
  image = decoded
}
guard image.width > 0, image.height > 0, image.width <= width, image.height <= height, image.width <= 4000000 / image.height else { fail("OCR recognition image exceeds processing bound") }
let recognize = VNRecognizeTextRequest()
recognize.revision = VNRecognizeTextRequestRevision2
recognize.recognitionLevel = .accurate
recognize.usesLanguageCorrection = false
let supported = try VNRecognizeTextRequest.supportedRecognitionLanguages(for: .accurate, revision: recognize.revision)
let unavailable = languages.filter { !supported.contains($0) }
guard unavailable.isEmpty else {
  fail("Native OCR language unavailable: " + unavailable.joined(separator: ", ") + "; supported: " + supported.joined(separator: ", "))
}
let chinese = ["zh-Hans", "zh-Hant"]
if languages.contains(where: { chinese.contains($0) }) {
  var sawEnglish = false
  for language in languages {
    if language == "en-US" { sawEnglish = true }
    else if !chinese.contains(language) || sawEnglish {
      fail("Vision revision 2 requires Chinese languages first, paired only with en-US")
    }
  }
}
recognize.recognitionLanguages = languages
try VNImageRequestHandler(cgImage: image, options: [:]).perform([recognize])
var texts: [[String: Any]] = []
var textBytes = 0
var truncated = false
for observation in recognize.results ?? [] {
  guard let candidate = observation.topCandidates(1).first, !candidate.string.isEmpty else { continue }
  let nextBytes = candidate.string.utf8.count
  if texts.count >= 96 || textBytes + nextBytes > 16384 {
    truncated = true
    break
  }
  let box = observation.boundingBox.intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
  if box.isNull || box.isEmpty { continue }
  textBytes += nextBytes
  texts.append([
    "text": candidate.string,
    "confidence": candidate.confidence,
    "box": ["x": box.minX * Double(width), "y": (1 - box.maxY) * Double(height),
            "width": box.width * Double(width), "height": box.height * Double(height)]
  ])
}
let result: [String: Any] = [
  "engine": "apple-vision", "revision": 2, "languages": languages,
  "width": width, "height": height, "texts": texts, "truncated": truncated,
  "recognitionSize": ["width": image.width, "height": image.height], "downsampled": image.width != width || image.height != height
]
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]))
`;
