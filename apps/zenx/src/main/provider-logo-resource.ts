import { createHash } from "node:crypto";
import { mkdir, open, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

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
    data.length >= 24 &&
    data
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    data.toString("ascii", 12, 16) === "IHDR" &&
    data.readUInt32BE(8) === 13
  )
    return {
      extension: "png",
      mime: "image/png",
      width: data.readUInt32BE(16),
      height: data.readUInt32BE(20),
    };
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 < data.length) {
      if (data[offset] !== 0xff) break;
      const marker = data[offset + 1]!;
      offset += 2;
      if (marker === 0xd9 || marker === 0xda) break;
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
        return {
          extension: "jpg",
          mime: "image/jpeg",
          width: data.readUInt16BE(offset + 5),
          height: data.readUInt16BE(offset + 3),
        };
      offset += length;
    }
  }
  if (
    data.length >= 30 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP" &&
    data.readUInt32LE(4) + 8 === data.length
  ) {
    const kind = data.toString("ascii", 12, 16);
    if (kind === "VP8X" && data.length >= 30)
      return {
        extension: "webp",
        mime: "image/webp",
        width: 1 + data.readUIntLE(24, 3),
        height: 1 + data.readUIntLE(27, 3),
      };
    if (kind === "VP8L" && data.length >= 25 && data[20] === 0x2f)
      return {
        extension: "webp",
        mime: "image/webp",
        width: 1 + (((data[22]! & 0x3f) << 8) | data[21]!),
        height:
          1 +
          (((data[24]! & 0x0f) << 10) |
            (data[23]! << 2) |
            ((data[22]! & 0xc0) >> 6)),
      };
    if (
      kind === "VP8 " &&
      data.length >= 30 &&
      data[23] === 0x9d &&
      data[24] === 0x01 &&
      data[25] === 0x2a
    )
      return {
        extension: "webp",
        mime: "image/webp",
        width: data.readUInt16LE(26) & 0x3fff,
        height: data.readUInt16LE(28) & 0x3fff,
      };
  }
  throw new Error("Provider Logo must be a valid PNG, JPEG, or WebP image");
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
