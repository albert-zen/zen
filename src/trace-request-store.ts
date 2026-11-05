import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { TraceArtifactRef } from "./trace.js";
import {
  assertRealDirectory,
  assertSameFile,
  isCode,
  syncDirectory,
  withOwnedFile,
  writeAll,
} from "./trace-storage-files.js";

interface Range {
  offset: number;
  limit: number;
}

/** Private, lossless representations: recipe and shared block paths never leave Trace. */
export class TraceRequestStore {
  readonly #artifacts: string;
  constructor(private readonly root: string) {
    this.#artifacts = path.join(root, "artifacts");
  }

  async store(ref: TraceArtifactRef, payload: Uint8Array): Promise<boolean> {
    const body = Buffer.from(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength,
    );
    const hasImages = body.includes(dataUrl);
    if (
      !hasImages &&
      (body.length < textBlockBytes || body.length > 0xffffffff)
    )
      return false;
    const verification = { offset: ref.byteLength, limit: 1 };
    if ((await this.read(ref, verification)) !== undefined) {
      await syncDirectory(this.#artifacts);
      return true;
    }
    if (!hasImages) return this.#storeText(ref, body);
    const name = this.#requestName(ref);
    const images: RequestImage[] = [];
    const seen = new Set<string>();
    for (const { image, bytes } of requestImages(body)) {
      images.push(image);
      if (seen.has(image.sha256)) continue;
      await this.#publish(this.#imageName(image), [bytes], () =>
        this.#readImage(image),
      );
      seen.add(image.sha256);
    }
    if (images.length === 0) return this.#storeText(ref, body);
    function* pieces() {
      yield encodeRequestImageIndex(images);
      let position = 0;
      for (const image of images) {
        yield body.subarray(position, image.start);
        position = image.start + encodedImageLength(image.byteLength);
      }
      yield body.subarray(position);
    }
    await this.#publish(name, pieces(), async () => {
      if ((await this.read(ref, verification)) === undefined)
        throw new Error(
          "Trace request image recipe disappeared during publication",
        );
    });
    return true;
  }

  async #storeText(ref: TraceArtifactRef, body: Buffer): Promise<boolean> {
    // Fixed byte boundaries reuse an unchanged growing prefix without retaining
    // another request, a dictionary, or a chain of dependent historical recipes.
    // Short requests stay raw; the last partial block stays inline in the recipe.
    if (body.length < textBlockBytes || body.length > 0xffffffff) return false;
    const count = Math.floor(body.length / textBlockBytes);
    const index = Buffer.alloc(4 + count * 32);
    index.writeUInt32BE(count);
    const seen = new Set<string>();
    for (let number = 0; number < count; number++) {
      const bytes = body.subarray(
        number * textBlockBytes,
        (number + 1) * textBlockBytes,
      );
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      index.write(sha256, 4 + number * 32, 32, "hex");
      if (seen.has(sha256)) continue;
      await this.#publish(this.#blockName(sha256), [bytes], async () => {
        await this.#readBlock(sha256);
      });
      seen.add(sha256);
    }
    await this.#publish(
      this.#textName(ref),
      [index, body.subarray(count * textBlockBytes)],
      async () => {
        if (
          (await this.read(ref, { offset: ref.byteLength, limit: 1 })) ===
          undefined
        )
          throw new Error(
            "Trace request text recipe disappeared during publication",
          );
      },
    );
    return true;
  }

  /** Undefined means no recipe was published. Damage inside a recipe fails closed. */
  async read(
    ref: TraceArtifactRef,
    range?: Range,
  ): Promise<Buffer | undefined> {
    const imageRecipe = await this.#exists(this.#requestName(ref));
    const name = imageRecipe ? this.#requestName(ref) : this.#textName(ref);
    if (!imageRecipe && !(await this.#exists(name))) return undefined;
    const hash = createHash("sha256");
    const page =
      range === undefined
        ? undefined
        : Buffer.alloc(
            Math.min(range.limit, Math.max(0, ref.byteLength - range.offset)),
          );
    const full: Buffer[] = [];
    let position = 0;
    function accept(chunk: Buffer) {
      hash.update(chunk);
      if (page === undefined || range === undefined) full.push(chunk);
      else {
        const from = Math.max(range.offset, position);
        const to = Math.min(
          range.offset + page.length,
          position + chunk.length,
        );
        if (to > from)
          chunk.copy(page, from - range.offset, from - position, to - position);
      }
      position += chunk.length;
    }
    await this.#withEntry(name, (filename) =>
      withOwnedFile(filename, async (file, metadata) => {
        if (!imageRecipe) {
          const count = (await readExact(file, 0, 4)).readUInt32BE();
          const literalStart = 4 + count * 32;
          const literalLength = metadata.size - literalStart;
          if (
            count < 1 ||
            count > maxTextBlocks ||
            literalLength < 0 ||
            literalLength >= textBlockBytes ||
            count * textBlockBytes + literalLength !== ref.byteLength
          )
            throw new Error("Invalid Trace request text index");
          const index = await readExact(file, 4, count * 32);
          for (let number = 0; number < count; number++)
            accept(
              await this.#readBlock(
                index.toString("hex", number * 32, (number + 1) * 32),
              ),
            );
          if (literalLength > 0)
            accept(await readExact(file, literalStart, literalLength));
          if ((await file.stat()).size !== metadata.size)
            throw integrityError();
          return;
        }
        const count = requestImageCount(await readExact(file, 0, 4));
        const indexLength = count * requestImageEntryBytes;
        let literalPosition = 4 + indexLength;
        const images = decodeRequestImageIndex(
          await readExact(file, 4, indexLength),
          metadata.size - literalPosition,
          ref.byteLength,
        );
        async function acceptLiteral(length: number) {
          for await (const chunk of fileChunks(file, literalPosition, length))
            accept(chunk);
          literalPosition += length;
        }
        for (const image of images) {
          await acceptLiteral(image.start - position);
          await this.#readImage(image, (chunk) =>
            accept(Buffer.from(chunk.toString("base64"), "ascii")),
          );
        }
        await acceptLiteral(metadata.size - literalPosition);
        if ((await file.stat()).size !== metadata.size) throw integrityError();
      }),
    );
    if (position !== ref.byteLength || hash.digest("hex") !== ref.sha256)
      throw integrityError();
    return page ?? Buffer.concat(full, position);
  }

  async #readBlock(sha256: string): Promise<Buffer> {
    return this.#withEntry(this.#blockName(sha256), (filename) =>
      withOwnedFile(filename, async (file, metadata) => {
        if (metadata.size !== textBlockBytes) throw integrityError();
        const bytes = await readExact(file, 0, textBlockBytes);
        if (
          (await file.stat()).size !== textBlockBytes ||
          createHash("sha256").update(bytes).digest("hex") !== sha256
        )
          throw integrityError();
        return bytes;
      }),
    );
  }

  async #readImage(
    image: RequestImage,
    accept?: (bytes: Buffer) => void,
  ): Promise<void> {
    await this.#withEntry(this.#imageName(image), (filename) =>
      withOwnedFile(filename, async (file, metadata) => {
        if (metadata.size !== image.byteLength) throw integrityError();
        const hash = createHash("sha256");
        // Every chunk except the last has a length divisible by three.
        for await (const chunk of fileChunks(
          file,
          0,
          image.byteLength,
          48 * 1024,
        )) {
          hash.update(chunk);
          accept?.(chunk);
        }
        if (
          (await file.stat()).size !== image.byteLength ||
          hash.digest("hex") !== image.sha256
        )
          throw integrityError();
      }),
    );
  }

  #requestName(ref: TraceArtifactRef): string {
    return `${ref.sha256}.request-v1`;
  }
  #textName(ref: TraceArtifactRef): string {
    return `${ref.sha256}.request-text-v1`;
  }
  #blockName(sha256: string): string {
    return `${sha256}.text-v1`;
  }
  #imageName(image: RequestImage): string {
    return `${image.sha256}.image-v1`;
  }
  async #assertParent(): Promise<void> {
    await assertRealDirectory(this.root);
    await assertRealDirectory(this.#artifacts);
  }
  async #exists(name: string): Promise<boolean> {
    await this.#assertParent();
    try {
      await assertRealDirectory(path.join(this.#artifacts, name));
      return true;
    } catch (error) {
      if (isCode(error, "ENOENT")) return false;
      throw error;
    }
  }
  async #withEntry<T>(
    name: string,
    operation: (filename: string) => Promise<T>,
  ): Promise<T> {
    await this.#assertParent();
    const entry = path.join(this.#artifacts, name);
    const before = await assertRealDirectory(entry);
    const result = await operation(path.join(entry, "data"));
    assertSameFile(before, await assertRealDirectory(entry));
    await this.#assertParent();
    return result;
  }
  async #publish(
    name: string,
    pieces: Iterable<Buffer>,
    verify: () => Promise<void>,
  ): Promise<void> {
    if (!(await this.#exists(name))) {
      const stage = path.join(this.#artifacts, `.${randomUUID()}.tmp`);
      await mkdir(stage, { mode: 0o700 });
      try {
        const file = await open(path.join(stage, "data"), "wx", 0o600);
        try {
          for (const piece of pieces) await writeAll(file, piece);
          await file.sync();
        } finally {
          await file.close();
        }
        await syncDirectory(stage);
        await this.#assertParent();
        try {
          // A published entry is a nonempty directory. Rename makes one owned
          // file visible atomically and concurrent writers cannot replace it.
          await rename(stage, path.join(this.#artifacts, name));
        } catch (error) {
          if (!(await this.#exists(name))) throw error;
        }
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
    }
    await verify();
    // Also sync when reusing a concurrent writer's entry before its own fsync.
    await syncDirectory(this.#artifacts);
  }
}

async function readExact(
  file: FileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await file.read(
      bytes,
      done,
      length - done,
      position + done,
    );
    if (bytesRead === 0) throw integrityError();
    done += bytesRead;
  }
  return bytes;
}

async function* fileChunks(
  file: FileHandle,
  start: number,
  length: number,
  chunkSize = 64 * 1024,
): AsyncGenerator<Buffer> {
  for (let read = 0; read < length; read += chunkSize)
    yield await readExact(
      file,
      start + read,
      Math.min(chunkSize, length - read),
    );
}

function integrityError(): Error {
  return new Error("Trace request artifact integrity mismatch");
}

const dataUrl = Buffer.from('"data:image/');
const textBlockBytes = 64 * 1024;
const maxTextBlocks = Math.floor(0xffffffff / textBlockBytes);
const mimeHeader = /^[a-z0-9][a-z0-9.+-]*;base64,/i;
const base64Alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const maxImages = 1024;
const minEncodedLength = 1024;
const requestImageEntryBytes = 40;

interface RequestImage {
  start: number;
  byteLength: number;
  sha256: string;
}

function encodedImageLength(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/** Find literal data URLs without parsing/reserializing the body or decoding its UTF-8. */
function* requestImages(
  body: Buffer,
): Generator<{ image: RequestImage; bytes: Buffer }> {
  if (body.length > 0xffffffff) return;
  let cursor = 0;
  for (let count = 0; count < maxImages;) {
    const quote = body.indexOf(dataUrl, cursor);
    if (quote < 0) return;
    const mimeStart = quote + dataUrl.length;
    cursor = mimeStart;
    let preceding = quote;
    while (preceding > 0 && body[preceding - 1] === 0x5c) preceding--;
    if ((quote - preceding) % 2 !== 0) continue;
    const header = mimeHeader.exec(
      body.toString("latin1", mimeStart, mimeStart + 128),
    );
    if (!header) continue;
    const start = mimeStart + header[0].length;
    const end = body.indexOf(0x22, start);
    if (end < 0) return;
    // Unrecognized encodings stay literal, including JSON escapes and nonzero pad bits.
    const size = end - start;
    if (size < minEncodedLength || size % 4 !== 0) continue;
    const padding = body[end - 1] !== 0x3d ? 0 : body[end - 2] === 0x3d ? 2 : 1;
    let valid = true;
    for (let i = start; i < end - padding; i++) {
      const code = body[i]!;
      if (!(
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        (code >= 48 && code <= 57) ||
        code === 0x2b ||
        code === 0x2f
      )) {
        valid = false;
        break;
      }
    }
    if (
      !valid ||
      (padding > 0 &&
        base64Alphabet.indexOf(String.fromCharCode(body[end - padding - 1]!)) %
          (padding === 2 ? 16 : 4) !==
          0)
    )
      continue;
    const bytes = Buffer.from(body.toString("latin1", start, end), "base64");
    count++;
    cursor = end + 1;
    yield {
      image: {
        start,
        byteLength: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      bytes,
    };
  }
}

/** v1: u32 count, fixed-size entries, then the original literal bytes in order. */
function encodeRequestImageIndex(images: readonly RequestImage[]): Buffer {
  const index = Buffer.alloc(4 + requestImageEntryBytes * images.length);
  index.writeUInt32BE(images.length);
  for (const [number, image] of images.entries()) {
    const offset = 4 + number * requestImageEntryBytes;
    index.writeUInt32BE(image.start, offset);
    index.writeUInt32BE(image.byteLength, offset + 4);
    index.write(image.sha256, offset + 8, 32, "hex");
  }
  return index;
}

function requestImageCount(header: Buffer): number {
  const count = header.readUInt32BE();
  if (count < 1 || count > maxImages) throw invalidIndex();
  return count;
}

function decodeRequestImageIndex(
  index: Buffer,
  literalLength: number,
  byteLength: number,
): RequestImage[] {
  const images: RequestImage[] = [];
  let previousEnd = 0;
  let removed = 0;
  for (
    let offset = 0;
    offset < index.length;
    offset += requestImageEntryBytes
  ) {
    const start = index.readUInt32BE(offset);
    const size = index.readUInt32BE(offset + 4);
    const end = start + encodedImageLength(size);
    if (start < previousEnd || size === 0 || end > byteLength)
      throw invalidIndex();
    images.push({
      start,
      byteLength: size,
      sha256: index.toString(
        "hex",
        offset + 8,
        offset + requestImageEntryBytes,
      ),
    });
    previousEnd = end;
    removed += end - start;
  }
  if (removed + literalLength !== byteLength) throw invalidIndex();
  return images;
}

function invalidIndex(): Error {
  return new Error("Invalid Trace request image index");
}
