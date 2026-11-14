/** Receipt adapter only: the legacy production component builder remains unchanged. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const started = performance.now();
const root = fileURLToPath(new URL("../../..", import.meta.url));
const directory = path.resolve(process.argv[2] ?? ".room-file-owner-preview");
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const commit = git("rev-parse", "HEAD");
assert.equal(
  commit,
  process.env.ZENX_ROOM_EXPECTED_HEAD,
  "Build only the workflow's fixed PR head",
);
assert.equal(git("status", "--porcelain"), "", "Build from a clean checkout");
execFileSync(
  process.execPath,
  [
    path.join(root, "apps/zenx/scripts/build-sidebar-state-preview.mjs"),
    directory,
  ],
  { cwd: root, stdio: "inherit" },
);
const previous = JSON.parse(
  await readFile(path.join(directory, "source.json"), "utf8"),
);
assert.equal(previous.commit, commit);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sources = Object.fromEntries(
  Object.entries(previous.sources).map(([file, value]) => [
    `apps/zenx/${file}`,
    value,
  ]),
);
for (const file of [
  "package-lock.json",
  ".github/workflows/room-file-owner-preview.yml",
  "apps/zenx/src/renderer/src/theme.css",
  "apps/zenx/scripts/build-room-file-owner-preview.mjs",
  "apps/zenx/scripts/room-file-owner-main-ui-preview.mjs",
  "apps/zenx/scripts/capture-main-ui-preview.mjs",
  "apps/zenx/scripts/preview-browser-lifecycle.mjs",
  "apps/zenx/scripts/prepare-preview-fonts.mjs",
  "apps/zenx/scripts/preview-font-probe.mjs",
  "apps/zenx/scripts/preview-fonts-OFL.txt",
])
  sources[file] = hash(await readFile(path.join(root, file)));
await rename(
  path.join(directory, "sidebar-state.html"),
  path.join(directory, "room.html"),
);
const html = await readFile(path.join(directory, "room.html"));
assert.equal(
  git("status", "--porcelain"),
  "",
  "Component build did not modify checkout sources",
);
const source = {
  commit,
  tree: git("rev-parse", "HEAD^{tree}"),
  clean: true,
  buildMs: Math.round(performance.now() - started),
  sources,
  scenes: { room: { html: "room.html", sha256: hash(html) } },
  scope:
    "Independent Room source-label component evidence, synthetic data only; not native Electron or strict A/B with the prior apt-font artifact. The required legacy CI remains separate.",
};
await writeFile(
  path.join(directory, "source.json"),
  JSON.stringify(source, null, 2) + "\n",
);
await writeFile(
  path.join(directory, "README.txt"),
  `${source.scope}\n\nThe legacy builder produced this HTML; its original README has been replaced because this artifact uses a distinct capture profile. No browser configuration is proven by building. Verify evidence.json browserSandboxDisabled and the exact capture source/arguments after execution. font-probe.png is an infrastructure SC specimen, not production UI. Actual production glyph faces are recorded separately without forcing an SC fallback. Diagnostic PNGs are not acceptance images.\n`,
);
