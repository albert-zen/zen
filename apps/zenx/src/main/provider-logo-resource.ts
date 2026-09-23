import { createHash } from "node:crypto";
import { mkdir, open, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";

export const MAX_PROVIDER_LOGO_BYTES = 512 * 1024;
export const MAX_PROVIDER_LOGO_SIDE = 1024;
const RESOURCE_NAME = /^[a-f0-9]{64}\.(png|jpg|webp)$/u;

export function validProviderLogoResource(value: unknown): value is string {
  return typeof value === "string" && RESOURCE_NAME.test(value);
}

export class ProviderLogoResources {
  readonly #directory: string;

  constructor(userDataDirectory: string) {
    this.#directory = path.join(userDataDirectory, "provider-logos");
  }

  async import(
    bytes: Uint8Array,
  ): Promise<{ resource: string; created: boolean }> {
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.length === 0 ||
      bytes.length > MAX_PROVIDER_LOGO_BYTES
    )
      throw new Error(
        "Provider Logo must be a nonempty image of at most 512 KiB",
      );
    const format = imageFormatAndSize(bytes);
    if (
      format.width < 1 ||
      format.height < 1 ||
      format.width > MAX_PROVIDER_LOGO_SIDE ||
      format.height > MAX_PROVIDER_LOGO_SIDE
    )
      throw new Error(
        "Provider Logo dimensions must be between 1 and 1024 pixels",
      );
    const resource = `${createHash("sha256").update(bytes).digest("hex")}.${format.extension}`;
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(path.join(this.#directory, resource), bytes, {
        flag: "wx",
        mode: 0o600,
      });
      return { resource, created: true };
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        if ((await this.dataUrl(resource)) === undefined)
          throw new Error("Existing Provider Logo resource is damaged");
        return { resource, created: false };
      }
      throw error;
    }
  }

  async dataUrl(resource: string): Promise<string | undefined> {
    if (!validProviderLogoResource(resource)) return undefined;
    let file;
    try {
      file = await open(path.join(this.#directory, resource), "r");
      const size = (await file.stat()).size;
      if (size > MAX_PROVIDER_LOGO_BYTES || size === 0) return undefined;
      const bytes = Buffer.alloc(size);
      const read = await file.read(bytes, 0, size, 0);
      if (read.bytesRead !== size) return undefined;
      const format = imageFormatAndSize(bytes);
      if (
        format.width < 1 ||
        format.height < 1 ||
        format.width > MAX_PROVIDER_LOGO_SIDE ||
        format.height > MAX_PROVIDER_LOGO_SIDE
      )
        return undefined;
      if (
        `${createHash("sha256").update(bytes).digest("hex")}.${format.extension}` !==
        resource
      )
        return undefined;
      return `data:${format.mime};base64,${bytes.toString("base64")}`;
    } catch {
      return undefined;
    } finally {
      await file?.close().catch(() => undefined);
    }
  }

  async remove(resource: string): Promise<void> {
    if (!validProviderLogoResource(resource)) return;
    try {
      await unlink(path.join(this.#directory, resource));
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
  }
}

function imageFormatAndSize(bytes: Uint8Array): {
  extension: "png" | "jpg" | "webp";
  mime: string;
  width: number;
  height: number;
} {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return pngFormatAndSize(data);
  if (
    data.length >= 8 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[data.length - 2] === 0xff &&
    data[data.length - 1] === 0xd9
  ) {
    let offset = 2;
    let size: { width: number; height: number } | undefined;
    let sawScan = false;
    while (offset + 4 < data.length) {
      if (data[offset] !== 0xff) break;
      const marker = data[offset + 1]!;
      offset += 2;
      if (marker === 0xd9) break;
      if (marker === 0xda) {
        if (offset + 2 > data.length) break;
        const length = data.readUInt16BE(offset);
        if (length < 2 || offset + length > data.length - 2) break;
        sawScan = true;
        break;
      }
      if (marker === 0x00 || marker === 0xff) continue;
      if (offset + 2 > data.length) break;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker) &&
        length >= 7
      )
        size = {
          width: data.readUInt16BE(offset + 5),
          height: data.readUInt16BE(offset + 3),
        };
      offset += length;
    }
    if (size !== undefined && sawScan)
      return { extension: "jpg", mime: "image/jpeg", ...size };
  }
  if (
    data.length >= 20 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP" &&
    data.readUInt32LE(4) + 8 === data.length
  ) {
    const chunks: { kind: string; offset: number; size: number }[] = [];
    let offset = 12;
    while (offset + 8 <= data.length) {
      const size = data.readUInt32LE(offset + 4);
      const end = offset + 8 + size + (size & 1);
      if (end > data.length) break;
      chunks.push({
        kind: data.toString("ascii", offset, offset + 4),
        offset: offset + 8,
        size,
      });
      offset = end;
    }
    if (offset !== data.length || chunks.length === 0)
      throw new Error("Provider Logo must be a valid PNG, JPEG, or WebP image");
    const first = chunks[0]!;
    const image = chunks.find(
      (chunk) => chunk.kind === "VP8 " || chunk.kind === "VP8L",
    );
    if (first.kind === "VP8X" && first.size === 10 && image !== undefined)
      return {
        extension: "webp",
        mime: "image/webp",
        width: 1 + data.readUIntLE(first.offset + 4, 3),
        height: 1 + data.readUIntLE(first.offset + 7, 3),
      };
    if (first.kind === "VP8L" && first.size >= 5 && data[first.offset] === 0x2f)
      return {
        extension: "webp",
        mime: "image/webp",
        width:
          1 +
          (((data[first.offset + 2]! & 0x3f) << 8) | data[first.offset + 1]!),
        height:
          1 +
          (((data[first.offset + 4]! & 0x0f) << 10) |
            (data[first.offset + 3]! << 2) |
            ((data[first.offset + 2]! & 0xc0) >> 6)),
      };
    if (
      first.kind === "VP8 " &&
      first.size >= 10 &&
      data[first.offset + 3] === 0x9d &&
      data[first.offset + 4] === 0x01 &&
      data[first.offset + 5] === 0x2a
    )
      return {
        extension: "webp",
        mime: "image/webp",
        width: data.readUInt16LE(first.offset + 6) & 0x3fff,
        height: data.readUInt16LE(first.offset + 8) & 0x3fff,
      };
  }
  throw new Error("Provider Logo must be a valid PNG, JPEG, or WebP image");
}

function pngFormatAndSize(data: Buffer): {
  extension: "png";
  mime: "image/png";
  width: number;
  height: number;
} {
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawEnd = false;
  const imageData: Buffer[] = [];
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > data.length) break;
    if (
      pngCrc32(data.subarray(offset + 4, offset + 8 + length)) !==
      data.readUInt32BE(offset + 8 + length)
    )
      break;
    if (offset === 8 && type !== "IHDR") break;
    if (type === "IHDR") {
      if (sawHeader || length !== 13) break;
      width = data.readUInt32BE(offset + 8);
      height = data.readUInt32BE(offset + 12);
      sawHeader = true;
    } else if (type === "IDAT") {
      imageData.push(data.subarray(offset + 8, offset + 8 + length));
    } else if (type === "IEND") {
      if (length !== 0 || end !== data.length) break;
      sawEnd = true;
      break;
    }
    offset = end;
  }
  if (!sawHeader || !sawEnd || imageData.length === 0)
    throw new Error("Provider Logo must be a valid PNG, JPEG, or WebP image");
  try {
    if (
      inflateSync(Buffer.concat(imageData), {
        maxOutputLength: 16 * 1024 * 1024,
      }).length === 0
    )
      throw new Error("Empty PNG image data");
  } catch {
    throw new Error("Provider Logo must be a valid PNG, JPEG, or WebP image");
  }
  return { extension: "png", mime: "image/png", width, height };
}

function pngCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
