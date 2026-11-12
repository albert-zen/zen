import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Compile the real Worker into this test's owned temporary directory, never a prior root build. */
export async function buildCodeRuntimeWorkerFixture(
  directory: string,
): Promise<URL> {
  const outfile = path.join(directory, "code-runtime-worker.mjs");
  await build({
    entryPoints: [
      fileURLToPath(
        new URL("../../../src/code-runtime-worker.ts", import.meta.url),
      ),
    ],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
  });
  return pathToFileURL(outfile);
}
