import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";

// Audited Microsoft node-pty 1.1.0 (MIT), lib/windowsPtyAgent.js.
// https://github.com/microsoft/node-pty/issues/967
// Preserve owned native ConPTY close and reader disposal; remove only the
// asynchronous, identity-unchecked process-list sweep from system ConPTY kill.
export const SHELL_PTY_PATCH = Object.freeze({
  version: "1.1.0",
  file: "lib/windowsPtyAgent.js",
  originalSha256:
    "8636d16b38266112204061a22b135734177c242837982fd3a4055be726efa64a",
  patchedSha256:
    "fa37392fe90a5b4352c3cc670936e42311a1e4942a626b44e795d6946a0f2adf",
});
const before =
  "                this._getConsoleProcessList().then(function (consoleProcessList) {\n                    consoleProcessList.forEach(function (pid) {\n                        try {\n                            process.kill(pid);\n                        }\n                        catch (e) {\n                            // Ignore if process cannot be found (kill ESRCH error)\n                        }\n                    });\n                });\n";
const after =
  "                // ZenX: close only the owned ConPTY; never schedule a bare-PID sweep.\n";
const digest = (source) => createHash("sha256").update(source).digest("hex");

async function load(directory) {
  const pkg = JSON.parse(
    await readFile(path.join(directory, "package.json"), "utf8"),
  );
  if (pkg.name !== "node-pty" || pkg.version !== SHELL_PTY_PATCH.version)
    throw new Error(
      "Unaudited node-pty version: Windows Shell cleanup requires reviewed node-pty 1.1.0",
    );
  const file = path.join(directory, SHELL_PTY_PATCH.file);
  const source = await readFile(file, "utf8");
  return { file, source, sha: digest(source) };
}

export async function verifyShellPtyPatch(directory) {
  if ((await load(directory)).sha !== SHELL_PTY_PATCH.patchedSha256)
    throw new Error(
      "Windows Shell cleanup patch is missing or unrecognized; run the supported install/preparation step",
    );
}

export async function applyShellPtyPatch(directory) {
  const { file, source, sha } = await load(directory);
  if (sha === SHELL_PTY_PATCH.patchedSha256) return;
  if (sha !== SHELL_PTY_PATCH.originalSha256)
    throw new Error(
      "Unrecognized node-pty source: refusing to modify Windows Shell cleanup",
    );
  const patched = source.replace(before, after);
  if (digest(patched) !== SHELL_PTY_PATCH.patchedSha256)
    throw new Error(
      "Windows Shell cleanup patch did not match its reviewed output",
    );
  const temporary = `${file}.zenx-${randomUUID()}`;
  try {
    await writeFile(temporary, patched, { flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  await verifyShellPtyPatch(directory);
}
