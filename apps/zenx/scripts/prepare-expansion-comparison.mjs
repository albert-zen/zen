// Test-fixture adapter only. Production files are never rewritten.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import pathModule from "node:path";
import { execFileSync } from "node:child_process";
const version = process.argv[2];
assert.ok(["before", "current"].includes(version));
const expected = {
  before: "c6f4592e15c6abbc5db890a86ceef0865f70681e",
  current: "4ed8fb0f2294d234a10cf293b67335f72d2bb332",
}[version];
assert.equal(
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  expected,
);
const panelSource = await readFile(
  "apps/zenx/src/renderer/src/auxiliary-panel.tsx",
  "utf8",
);
assert.equal(
  panelSource.includes("primaryConversation"),
  version === "current",
);
const path = "apps/zenx/scripts/titlebar-safe-area-preview.tsx";
let text = await readFile(path, "utf8");
const replace = (from, to) => {
  assert.ok(text.includes(from), `Missing fixture anchor: ${from}`);
  text = text.replace(from, to);
};
replace(
  "const fixtureTabs = realSubject ? customTabs.slice(1) : customTabs;",
  'const fixtureTabs = (realSubject ? customTabs.slice(1) : customTabs).slice(0, Math.max(0, Number(query.get("resources") ?? "1") - (realSubject ? 1 : 0)));',
);
replace(
  '<section className="agent-surface">',
  '<section className="agent-surface" id="primary-conversation-content">',
);
if (version === "current")
  replace(
    "<AuxiliaryPanel\n",
    `<AuxiliaryPanel\n          primaryConversation={{title: i18n.t("panels:mainConversation", { title: "Synthetic conversation" }), contentId: "primary-conversation-content"}}\n`,
  );
// Match each source revision's production entry CSS order (including shell and post-styles overrides).
const main = await readFile("apps/zenx/src/renderer/src/main.tsx", "utf8");
const css = [...main.matchAll(/import "\.\/([^"\n]+\.css)";/g)].map(
  (m) => m[1],
);
assert.equal(css[0], "shell-thread-panel.css");
replace(
  "import React,",
  `import "../src/renderer/src/${css[0]}";\nimport React,`,
);
replace(
  'import "../src/renderer/src/theme.css";\nimport "../src/renderer/src/styles.css";',
  css
    .slice(1)
    .map((file) => `import "../src/renderer/src/${file}";`)
    .join("\n"),
);
await writeFile(path, text);
// Diagnostic copy preserves the existing lifecycle but keeps Chromium's sandbox enabled.
const helper = await readFile("apps/zenx/scripts/preview-browser.mjs", "utf8");
assert.ok(helper.includes('      "--no-sandbox",\n'));
await writeFile(
  "apps/zenx/scripts/expansion-preview-browser.mjs",
  helper.replace('      "--no-sandbox",\n', ""),
);

// Builder records exact original commit plus hashes of the modified fixture.
console.log(
  JSON.stringify({
    version,
    sourceCommit: expected,
    fixture: path,
    scope:
      "Actual version-specific WindowTitleBar/AuxiliaryPanel/CSS; synthetic sidebar/native markers and Subagents contents; no native Electron acceptance",
  }),
);

if (process.argv[3]) {
  const output = pathModule.resolve(process.argv[3]);
  await mkdir(output, { recursive: true });
  const files = [
    "apps/zenx/src/renderer/src/main.tsx",
    "apps/zenx/src/renderer/src/App.tsx",
    "apps/zenx/src/renderer/src/auxiliary-panel.tsx",
    ...css.map((f) => "apps/zenx/src/renderer/src/" + f),
    path,
    "apps/zenx/scripts/expansion-preview-browser.mjs",
    "apps/zenx/scripts/prepare-expansion-comparison.mjs",
    "apps/zenx/scripts/capture-expansion-comparison.mjs",
  ];
  const hashes = Object.fromEntries(
    await Promise.all(
      files.map(async (f) => [
        f,
        createHash("sha256")
          .update(await readFile(f))
          .digest("hex"),
      ]),
    ),
  );
  await writeFile(
    pathModule.join(output, "comparison-source.json"),
    JSON.stringify(
      {
        version,
        sourceCommit: expected,
        cssImportOrder: css,
        sha256: hashes,
        browserSandbox: "default enabled; no --no-sandbox flag",
        fixtureBoundary:
          "Actual version-specific shell components; synthetic already-created thread, plugin manifest, and body. Does not execute thread creation, Host or native Electron.",
      },
      null,
      2,
    ) + "\n",
  );
}
