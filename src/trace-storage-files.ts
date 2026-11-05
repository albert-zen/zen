import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

export async function assertRealDirectory(directory: string): Promise<Stats> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error(
      "Trace storage must be an owned real directory, not an alias",
    );
  return metadata;
}
export function assertOwnedRegularFile(metadata: Stats): void {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1)
    throw new Error(
      "Trace storage must be an owned regular file, not a symbolic or hard-link alias",
    );
}
export function assertSameFile(left: Stats, right: Stats): void {
  if (left.dev !== right.dev || left.ino !== right.ino)
    throw new Error("Trace file ownership changed during access");
}
export async function readOwnedFile(filename: string): Promise<Buffer> {
  return withOwnedFile(filename, (file) => file.readFile());
}
export async function withOwnedFile<T>(
  filename: string,
  operation: (file: FileHandle, opened: Stats) => Promise<T>,
): Promise<T> {
  const before = await lstat(filename);
  assertOwnedRegularFile(before);
  const file = await open(
    filename,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await file.stat();
    assertOwnedRegularFile(opened);
    assertSameFile(before, opened);
    const result = await operation(file, opened);
    const after = await lstat(filename);
    assertOwnedRegularFile(after);
    assertSameFile(opened, after);
    return result;
  } finally {
    await file.close();
  }
}
export async function syncDirectory(directory: string): Promise<boolean> {
  if (process.platform === "win32") return false;
  const file = await open(directory, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  return true;
}
export async function writeAll(
  file: FileHandle,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await file.write(bytes, offset, bytes.byteLength - offset);
    if (result.bytesWritten === 0)
      throw new Error("Trace write made no progress");
    offset += result.bytesWritten;
  }
}
export function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
