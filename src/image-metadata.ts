import type { ImageMediaType } from "./attachment.js";

/** libvips rewrites EXIF pixel-size tags on resize; Codex copies the raw EXIF.
 * Copy the original format's complete EXIF container chunk after encoding.
 * No source payload is changed, no metadata is interpreted as an instruction.
 */
export function preserveImageExif(
  source: Uint8Array,
  encoded: Uint8Array,
  mediaType: ImageMediaType,
): Uint8Array {
  const original = Buffer.from(source);
  const output = Buffer.from(encoded);
  if (mediaType === "image/jpeg") {
    const segments = jpegSegments(original);
    const exif = segments.filter((s) => isJpegExif(original, s));
    if (exif.length === 0) return encoded;
    const chunks: Buffer[] = [
      output.subarray(0, 2),
      ...exif.map((s) => original.subarray(s.start, s.end)),
    ];
    let cursor = 2;
    for (const segment of jpegSegments(output)) {
      if (!isJpegExif(output, segment)) continue;
      chunks.push(output.subarray(cursor, segment.start));
      cursor = segment.end;
    }
    chunks.push(output.subarray(cursor));
    return Buffer.concat(chunks);
  }
  if (mediaType === "image/png") {
    const exif = chunks(original, 8, false).filter(
      (chunk) => chunk.type === "eXIf",
    );
    if (exif.length === 0) return encoded;
    const parts = [output.subarray(0, 8)];
    let inserted = false;
    for (const chunk of chunks(output, 8, false)) {
      if (chunk.type === "eXIf") continue;
      if (!inserted && chunk.type === "IDAT") {
        parts.push(
          ...exif.map((chunk) => original.subarray(chunk.start, chunk.end)),
        );
        inserted = true;
      }
      parts.push(output.subarray(chunk.start, chunk.end));
    }
    if (!inserted) throw new Error("Prepared PNG has no image data");
    return Buffer.concat(parts);
  }
  if (mediaType === "image/webp") {
    const exif = chunks(original, 12, true).filter(
      (chunk) => chunk.type === "EXIF",
    );
    if (exif.length === 0) return encoded;
    const parts = [
      output.subarray(0, 12),
      ...chunks(output, 12, true)
        .filter((chunk) => chunk.type !== "EXIF")
        .map((chunk) => output.subarray(chunk.start, chunk.end)),
      ...exif.map((chunk) => original.subarray(chunk.start, chunk.end)),
    ];
    const result = Buffer.concat(parts);
    result.writeUInt32LE(result.length - 8, 4);
    return result;
  }
  return encoded;
}

interface Chunk {
  start: number;
  end: number;
  type: string;
}
function chunks(bytes: Buffer, start: number, webp: boolean): Chunk[] {
  const result: Chunk[] = [];
  for (let offset = start; offset < bytes.length;) {
    if (offset + 8 > bytes.length)
      throw new Error("Truncated image metadata chunk");
    const length = webp
      ? bytes.readUInt32LE(offset + 4)
      : bytes.readUInt32BE(offset);
    const end = offset + length + (webp ? 8 + (length % 2) : 12);
    if (end > bytes.length)
      throw new Error("Invalid image metadata chunk length");
    result.push({
      start: offset,
      end,
      type: bytes.toString(
        "ascii",
        offset + (webp ? 0 : 4),
        offset + (webp ? 4 : 8),
      ),
    });
    offset = end;
  }
  return result;
}
function jpegSegments(bytes: Buffer): Chunk[] {
  const result: Chunk[] = [];
  for (let offset = 2; offset < bytes.length;) {
    const start = offset;
    if (bytes[offset] !== 0xff) throw new Error("Invalid JPEG metadata marker");
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++]!;
    if (marker === 0xda || marker === 0xd9) break; // compressed image data / end
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length)
      throw new Error("Truncated JPEG metadata length");
    const length = bytes.readUInt16BE(offset);
    const end = offset + length;
    if (length < 2 || end > bytes.length)
      throw new Error("Invalid JPEG metadata length");
    result.push({ start, end, type: String(marker) });
    offset = end;
  }
  return result;
}
function isJpegExif(bytes: Buffer, segment: Chunk): boolean {
  // Account for legal FF marker padding instead of assuming a fixed header.
  let marker = segment.start;
  while (bytes[marker] === 0xff) marker++;
  return (
    bytes[marker] === 0xe1 &&
    bytes.toString("ascii", marker + 3, marker + 9) === "Exif\0\0"
  );
}
