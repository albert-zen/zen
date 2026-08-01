import { open } from "node:fs/promises";

export async function readBearerTokenFile(filePath: string): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error(`Bearer token path is not a regular file: ${filePath}`);
    }
    if (process.platform !== "win32" && (metadata.mode & 0o044) !== 0) {
      throw new Error(
        `Bearer token file is readable by group or others; run chmod 600 ${filePath}`,
      );
    }
    const token = (await handle.readFile("utf8")).trim();
    if (token.length === 0) {
      throw new Error(`Bearer token file is empty: ${filePath}`);
    }
    if (token.includes("\n") || token.includes("\r")) {
      throw new Error("Bearer token file must contain exactly one token");
    }
    return token;
  } finally {
    await handle.close();
  }
}
