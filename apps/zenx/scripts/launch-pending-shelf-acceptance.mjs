/** Real production React components in disposable native Electron windows. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import electron from "electron";
assert.equal(process.env.GITHUB_ACTIONS, "true");
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.resolve(process.argv[2]);
await mkdir(directory, { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), "zenx-pending-shelf-"));
try {
  for (const name of ["queue-steer-visual", "pending-send-visual"]) {
    await build({
      entryPoints: [path.join(root, `test/fixtures/${name}.tsx`)],
      bundle: true,
      outdir: temporary,
      format: "iife",
      define: { "import.meta.url": "window.location.href" },
    });
    const css = await readFile(path.join(temporary, name + ".css"), "utf8");
    const js = await readFile(path.join(temporary, name + ".js"), "utf8");
    await writeFile(
      path.join(temporary, name + ".html"),
      `<!doctype html><html><head><meta charset="UTF-8"><style>${css}</style></head><body><div id="root"></div><script>${js.replaceAll("</script", "<\\/script")}</script></body></html>`,
    );
  }
  await writeFile(
    path.join(directory, "source.json"),
    JSON.stringify(
      {
        sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        synthetic: true,
        scope:
          "Production ThreadView, PendingSteerPanel, PendingSendRows components and CSS, synthetic fixture data, native Electron layout. No production Host or user profile.",
      },
      null,
      2,
    ),
  );
  const child = spawn(
    electron,
    [
      path.join(root, "scripts/capture-pending-shelf.cjs"),
      directory,
      temporary,
      `--user-data-dir=${path.join(temporary, "profile")}`,
    ],
    {
      stdio: "inherit",
      env: { ...process.env, ZENX_DATA_DIR: path.join(temporary, "zen-data") },
    },
  );
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  assert.equal(code, 0, "Pending shelf native component acceptance failed");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
