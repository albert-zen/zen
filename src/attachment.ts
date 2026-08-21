import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 16_384;
export const MAX_IMAGE_PIXELS = 40_000_000;
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let entry = value;
  for (let bit = 0; bit < 8; bit += 1) {
    entry = (entry >>> 1) ^ (entry & 1 ? 0xedb88320 : 0);
  }
  return entry >>> 0;
});

export type ImageMediaType =
  "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface AttachmentRef {
  type: "attachment";
  sha256: string;
  mediaType: ImageMediaType;
  byteLength: number;
  width: number;
  height: number;
}

export interface AttachmentStore {
  importBytes(
    bytes: Uint8Array,
    declaredMediaType?: string,
  ): Promise<AttachmentRef>;
  importLocalImage(filename: string): Promise<AttachmentRef>;
  read(ref: AttachmentRef): Promise<Uint8Array>;
}

export class AttachmentStoreError extends Error {
  readonly code:
    | "attachment_invalid"
    | "attachment_too_large"
    | "attachment_dimensions_exceeded"
    | "attachment_mime_mismatch"
    | "attachment_missing"
    | "attachment_corrupt";

  constructor(code: AttachmentStoreError["code"], message: string) {
    super(message);
    this.name = "AttachmentStoreError";
    this.code = code;
  }
}

export class InMemoryAttachmentStore implements AttachmentStore {
  readonly #payloads = new Map<string, Uint8Array>();

  async importBytes(
    bytes: Uint8Array,
    declaredMediaType?: string,
  ): Promise<AttachmentRef> {
    const ref = inspectImage(bytes, declaredMediaType);
    const existing = this.#payloads.get(ref.sha256);
    if (existing === undefined) {
      this.#payloads.set(ref.sha256, Uint8Array.from(bytes));
    } else {
      assertStoredBytes(existing, ref);
    }
    return ref;
  }

  async importLocalImage(filename: string): Promise<AttachmentRef> {
    return await this.importBytes(await readLocalImage(filename));
  }

  async read(ref: AttachmentRef): Promise<Uint8Array> {
    validateAttachmentRef(ref);
    const bytes = this.#payloads.get(ref.sha256);
    if (bytes === undefined) {
      throw new AttachmentStoreError(
        "attachment_missing",
        `Attachment ${ref.sha256} is missing`,
      );
    }
    assertStoredBytes(bytes, ref);
    return Uint8Array.from(bytes);
  }
}

export class FileAttachmentStore implements AttachmentStore {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = path.resolve(directory);
  }

  async importBytes(
    bytes: Uint8Array,
    declaredMediaType?: string,
  ): Promise<AttachmentRef> {
    const ref = inspectImage(bytes, declaredMediaType);
    const hashRoot = path.join(this.#directory, "sha256");
    const finalDirectory = path.join(hashRoot, ref.sha256);
    const finalPath = path.join(finalDirectory, "payload");
    await mkdir(hashRoot, { recursive: true, mode: 0o700 });

    try {
      const existing = await readFile(finalPath);
      assertStoredBytes(existing, ref);
      return ref;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }

    const temporaryDirectory = path.join(
      hashRoot,
      `.tmp-${process.pid.toString(36)}-${randomUUID()}`,
    );
    await mkdir(temporaryDirectory, { mode: 0o700 });
    let published = false;
    try {
      const temporaryPath = path.join(temporaryDirectory, "payload");
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(temporaryPath, 0o400);
      try {
        await rename(temporaryDirectory, finalDirectory);
        published = true;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }

      if (!published) {
        const existing = await readFile(finalPath);
        assertStoredBytes(existing, ref);
      }
      return ref;
    } finally {
      if (!published) {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    }
  }

  async importLocalImage(filename: string): Promise<AttachmentRef> {
    return await this.importBytes(await readLocalImage(filename));
  }

  async read(ref: AttachmentRef): Promise<Uint8Array> {
    validateAttachmentRef(ref);
    let bytes: Uint8Array;
    try {
      bytes = await readFile(
        path.join(this.#directory, "sha256", ref.sha256, "payload"),
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new AttachmentStoreError(
          "attachment_missing",
          `Attachment ${ref.sha256} is missing`,
        );
      }
      throw error;
    }
    assertStoredBytes(bytes, ref);
    return bytes;
  }
}

export function decodeImageDataUri(value: string): {
  bytes: Uint8Array;
  mediaType: string;
} {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(value);
  if (match === null) {
    throw new AttachmentStoreError(
      "attachment_invalid",
      "Image input must be a base64 data URI",
    );
  }
  const mediaType = match[1]!;
  const encoded = match[2]!;
  if (encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) {
    throw tooLargeError();
  }
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.toString("base64").replace(/=+$/u, "") !== encoded.replace(/=+$/u, "")
  ) {
    throw new AttachmentStoreError(
      "attachment_invalid",
      "Image data URI contains invalid base64",
    );
  }
  return { bytes, mediaType };
}

async function readLocalImage(filename: string): Promise<Uint8Array> {
  const handle = await open(path.resolve(filename), "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new AttachmentStoreError(
        "attachment_invalid",
        "Local image input must be a regular file",
      );
    }
    if (metadata.size > MAX_IMAGE_BYTES) throw tooLargeError();
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function inspectImage(
  bytes: Uint8Array,
  declaredMediaType?: string,
): AttachmentRef {
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw tooLargeError();
  const image = imageMetadata(bytes);
  if (
    declaredMediaType !== undefined &&
    declaredMediaType.toLowerCase() !== image.mediaType
  ) {
    throw new AttachmentStoreError(
      "attachment_mime_mismatch",
      `Declared image MIME ${declaredMediaType} does not match ${image.mediaType}`,
    );
  }
  if (
    image.width <= 0 ||
    image.height <= 0 ||
    image.width > MAX_IMAGE_DIMENSION ||
    image.height > MAX_IMAGE_DIMENSION ||
    image.width * image.height > MAX_IMAGE_PIXELS
  ) {
    throw new AttachmentStoreError(
      "attachment_dimensions_exceeded",
      `Image dimensions ${String(image.width)}x${String(image.height)} exceed Zen limits`,
    );
  }
  return {
    type: "attachment",
    sha256: sha256(bytes),
    mediaType: image.mediaType,
    byteLength: bytes.byteLength,
    width: image.width,
    height: image.height,
  };
}

function imageMetadata(bytes: Uint8Array): {
  mediaType: ImageMediaType;
  width: number;
  height: number;
} {
  if (isPng(bytes)) return pngMetadata(bytes);
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") {
    return gifMetadata(bytes);
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegMetadata(bytes);
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return webpMetadata(bytes);
  }
  return invalidImage();
}

function isPng(bytes: Uint8Array): boolean {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  return signature.every((value, index) => bytes[index] === value);
}

function pngMetadata(bytes: Uint8Array) {
  if (bytes.length < 45) return invalidImage();
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawImageData = false;
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = uint32be(bytes, offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return invalidImage();
    const type = ascii(bytes, offset + 4, 4);
    if (!/^[A-Za-z]{4}$/u.test(type)) return invalidImage();
    if (
      crc32(bytes.subarray(offset + 4, offset + 8 + length)) !==
      uint32be(bytes, offset + 8 + length)
    ) {
      return invalidImage();
    }
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) return invalidImage();
      width = uint32be(bytes, offset + 8);
      height = uint32be(bytes, offset + 12);
      const bitDepth = bytes[offset + 16];
      const colorType = bytes[offset + 17];
      if (
        bitDepth === undefined ||
        colorType === undefined ||
        !validPngColorDepth(colorType, bitDepth) ||
        bytes[offset + 18] !== 0 ||
        bytes[offset + 19] !== 0 ||
        (bytes[offset + 20] !== 0 && bytes[offset + 20] !== 1)
      ) {
        return invalidImage();
      }
      sawHeader = true;
    } else if (type === "IHDR") {
      return invalidImage();
    } else if (type === "IDAT") {
      sawImageData = true;
    } else if (type === "IEND") {
      ended = length === 0 && end === bytes.length;
      break;
    }
    offset = end;
  }
  if (!ended || !sawImageData) return invalidImage();
  return {
    mediaType: "image/png" as const,
    width,
    height,
  };
}

function validPngColorDepth(colorType: number, bitDepth: number): boolean {
  switch (colorType) {
    case 0:
      return [1, 2, 4, 8, 16].includes(bitDepth);
    case 2:
    case 4:
    case 6:
      return bitDepth === 8 || bitDepth === 16;
    case 3:
      return [1, 2, 4, 8].includes(bitDepth);
    default:
      return false;
  }
}

function gifMetadata(bytes: Uint8Array) {
  if (bytes.length < 14) return invalidImage();
  const width = uint16le(bytes, 6);
  const height = uint16le(bytes, 8);
  const packed = bytes[10]!;
  let offset = 13;
  if ((packed & 0x80) !== 0) {
    offset += 3 * 2 ** ((packed & 0x07) + 1);
  }
  if (offset > bytes.length) return invalidImage();
  let sawImage = false;
  while (offset < bytes.length) {
    const introducer = bytes[offset++];
    if (introducer === 0x3b) {
      if (!sawImage || offset !== bytes.length) return invalidImage();
      return { mediaType: "image/gif" as const, width, height };
    }
    if (introducer === 0x21) {
      if (offset >= bytes.length) return invalidImage();
      offset += 1;
      offset = skipGifSubBlocks(bytes, offset);
      continue;
    }
    if (introducer !== 0x2c || offset + 9 > bytes.length) {
      return invalidImage();
    }
    const imagePacked = bytes[offset + 8]!;
    offset += 9;
    if ((imagePacked & 0x80) !== 0) {
      offset += 3 * 2 ** ((imagePacked & 0x07) + 1);
    }
    if (offset >= bytes.length) return invalidImage();
    const minimumCodeSize = bytes[offset++]!;
    if (minimumCodeSize < 2 || minimumCodeSize > 8) return invalidImage();
    offset = skipGifSubBlocks(bytes, offset);
    sawImage = true;
  }
  return invalidImage();
}

function skipGifSubBlocks(bytes: Uint8Array, start: number): number {
  let offset = start;
  while (offset < bytes.length) {
    const length = bytes[offset++]!;
    if (length === 0) return offset;
    offset += length;
    if (offset > bytes.length) return invalidImage();
  }
  return invalidImage();
}

function jpegMetadata(bytes: Uint8Array) {
  if (bytes.length < 4 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
    return invalidImage();
  }
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawFrame = false;
  let sawScan = false;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return invalidImage();
    while (bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return invalidImage();
    const marker = bytes[offset++]!;
    if (marker === 0x00) return invalidImage();
    if (marker === 0xd9) {
      if (!sawFrame || !sawScan || offset !== bytes.length) {
        return invalidImage();
      }
      return { mediaType: "image/jpeg" as const, width, height };
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return invalidImage();
    const length = uint16be(bytes, offset);
    if (length < 2 || offset + length > bytes.length) return invalidImage();
    if (isJpegStartOfFrame(marker)) {
      if (length < 8 || sawFrame) return invalidImage();
      height = uint16be(bytes, offset + 3);
      width = uint16be(bytes, offset + 5);
      sawFrame = true;
    }
    offset += length;
    if (marker === 0xda) {
      if (!sawFrame) return invalidImage();
      sawScan = true;
      offset = nextJpegMarker(bytes, offset);
    }
  }
  return invalidImage();
}

function nextJpegMarker(bytes: Uint8Array, start: number): number {
  let offset = start;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) continue;
    const markerStart = offset - 1;
    while (bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return invalidImage();
    const marker = bytes[offset]!;
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 1;
      continue;
    }
    return markerStart;
  }
  return invalidImage();
}

function isJpegStartOfFrame(marker: number): boolean {
  return [
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf,
  ].includes(marker);
}

function webpMetadata(bytes: Uint8Array) {
  if (bytes.length < 30 || uint32le(bytes, 4) + 8 !== bytes.length) {
    return invalidImage();
  }
  let offset = 12;
  let width = 0;
  let height = 0;
  let sawDimensions = false;
  let sawImageData = false;
  while (offset + 8 <= bytes.length) {
    const kind = ascii(bytes, offset, 4);
    const length = uint32le(bytes, offset + 4);
    const data = offset + 8;
    const end = data + length;
    const paddedEnd = end + (length & 1);
    if (end > bytes.length || paddedEnd > bytes.length) return invalidImage();
    if (kind === "VP8X") {
      if (length !== 10 || sawDimensions) return invalidImage();
      width = uint24le(bytes, data + 4) + 1;
      height = uint24le(bytes, data + 7) + 1;
      sawDimensions = true;
    } else if (kind === "VP8L") {
      if (length < 5 || bytes[data] !== 0x2f) return invalidImage();
      const bits = uint32le(bytes, data + 1);
      const chunkWidth = (bits & 0x3fff) + 1;
      const chunkHeight = ((bits >>> 14) & 0x3fff) + 1;
      if (sawDimensions && (width !== chunkWidth || height !== chunkHeight)) {
        return invalidImage();
      }
      width = chunkWidth;
      height = chunkHeight;
      sawDimensions = true;
      sawImageData = true;
    } else if (kind === "VP8 ") {
      if (
        length < 10 ||
        bytes[data + 3] !== 0x9d ||
        bytes[data + 4] !== 0x01 ||
        bytes[data + 5] !== 0x2a
      ) {
        return invalidImage();
      }
      const chunkWidth = uint16le(bytes, data + 6) & 0x3fff;
      const chunkHeight = uint16le(bytes, data + 8) & 0x3fff;
      if (sawDimensions && (width !== chunkWidth || height !== chunkHeight)) {
        return invalidImage();
      }
      width = chunkWidth;
      height = chunkHeight;
      sawDimensions = true;
      sawImageData = true;
    } else if (kind === "ANMF") {
      if (length < 24 || !webpFrameHasImage(bytes, data + 16, end)) {
        return invalidImage();
      }
      sawImageData = true;
    }
    offset = paddedEnd;
  }
  if (offset !== bytes.length || !sawDimensions || !sawImageData) {
    return invalidImage();
  }
  return { mediaType: "image/webp" as const, width, height };
}

function webpFrameHasImage(
  bytes: Uint8Array,
  start: number,
  end: number,
): boolean {
  let offset = start;
  while (offset + 8 <= end) {
    const kind = ascii(bytes, offset, 4);
    const length = uint32le(bytes, offset + 4);
    const data = offset + 8;
    const chunkEnd = data + length;
    const paddedEnd = chunkEnd + (length & 1);
    if (chunkEnd > end || paddedEnd > end) return false;
    if (
      (kind === "VP8L" && length >= 5 && bytes[data] === 0x2f) ||
      (kind === "VP8 " &&
        length >= 10 &&
        bytes[data + 3] === 0x9d &&
        bytes[data + 4] === 0x01 &&
        bytes[data + 5] === 0x2a)
    ) {
      return true;
    }
    offset = paddedEnd;
  }
  return false;
}

function assertStoredBytes(bytes: Uint8Array, ref: AttachmentRef): void {
  validateAttachmentRef(ref);
  if (bytes.byteLength !== ref.byteLength || sha256(bytes) !== ref.sha256) {
    throw new AttachmentStoreError(
      "attachment_corrupt",
      `Attachment ${ref.sha256} does not match its immutable reference`,
    );
  }
  const inspected = inspectImage(bytes, ref.mediaType);
  if (inspected.width !== ref.width || inspected.height !== ref.height) {
    throw new AttachmentStoreError(
      "attachment_corrupt",
      `Attachment ${ref.sha256} metadata does not match its immutable reference`,
    );
  }
}

function validateAttachmentRef(ref: AttachmentRef): void {
  if (
    ref.type !== "attachment" ||
    !/^[a-f0-9]{64}$/u.test(ref.sha256) ||
    !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
      ref.mediaType,
    ) ||
    !Number.isSafeInteger(ref.byteLength) ||
    ref.byteLength <= 0 ||
    ref.byteLength > MAX_IMAGE_BYTES ||
    !Number.isSafeInteger(ref.width) ||
    !Number.isSafeInteger(ref.height) ||
    ref.width <= 0 ||
    ref.height <= 0 ||
    ref.width > MAX_IMAGE_DIMENSION ||
    ref.height > MAX_IMAGE_DIMENSION ||
    ref.width * ref.height > MAX_IMAGE_PIXELS
  ) {
    throw new AttachmentStoreError(
      "attachment_corrupt",
      "AttachmentRef is invalid",
    );
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function tooLargeError(): AttachmentStoreError {
  return new AttachmentStoreError(
    "attachment_too_large",
    `Image exceeds the ${String(MAX_IMAGE_BYTES)} byte limit`,
  );
}

function invalidImage(): never {
  throw new AttachmentStoreError(
    "attachment_invalid",
    "Image payload is corrupt or uses an unsupported format",
  );
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return Buffer.from(bytes.subarray(offset, offset + length)).toString("ascii");
}

function uint16be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function uint16le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function uint24le(bytes: Uint8Array, offset: number): number {
  return uint16le(bytes, offset) | ((bytes[offset + 2] ?? 0) << 16);
}

function uint32be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function uint32le(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) +
      ((bytes[offset + 1] ?? 0) << 8) +
      ((bytes[offset + 2] ?? 0) << 16) +
      (bytes[offset + 3] ?? 0) * 0x1000000) >>>
    0
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isAlreadyExists(error: unknown): boolean {
  return (
    isNodeError(error) &&
    (error.code === "EEXIST" ||
      error.code === "ENOTEMPTY" ||
      error.code === "EACCES")
  );
}
