import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

const read = async (p) =>
  readFile(new URL(`../../../${p}`, import.meta.url), "utf8");
const scripts = JSON.parse(await read("apps/zenx/package.json")).scripts;

test("fixture build keeps first-party preparation and the same compiler without product RTK acquisition", () => {
  assert.equal(
    scripts["prebuild:fixtures"],
    "npm run prepare:first-party-plugins",
  );
  assert.equal(scripts["build:fixtures"], "npm run build:prepared");
  assert.equal(scripts["build:prepared"], "electron-vite build");
  assert.equal(
    scripts.prebuild,
    "npm run prepare:first-party-plugins && npm run prepare:rtk",
  );
  assert.equal(scripts.build, "electron-vite build");
  assert.equal(
    scripts.predev,
    "npm run prepare:first-party-plugins && npm run prepare:rtk",
  );
});

test("only the audited standalone browser fixtures use the new lifecycle", async () => {
  for (const [name, entry] of [
    ["smoke:providers", "electron ./out/main/provider-smoke.js"],
    [
      "smoke:workspace-browser",
      "electron ./out/main/workspace-browser-smoke.js",
    ],
    [
      "smoke:workspace-browser-persistence",
      "node ./scripts/workspace-browser-persistence-smoke.mjs",
    ],
  ])
    assert.equal(scripts[name], `npm run build:fixtures && ${entry}`);
  assert.equal(
    scripts["smoke:real"],
    "npm run build && electron ./out/main/real-smoke.js",
  );
  assert.equal(
    scripts["smoke:unit-capabilities"],
    "npm run build && electron ./out/main/capability-smoke.js",
  );
  assert.equal(
    scripts["package:portable"],
    "node ./scripts/package-zenx-portable.mjs --app",
  );
  assert.equal(
    scripts["smoke:packaged"],
    "node ./scripts/package-zenx-portable.mjs",
  );
  for (const file of ["information-board.yml", "user-question-ui.yml"]) {
    const workflow = parse(await read(`.github/workflows/${file}`));
    assert.ok(
      Object.values(workflow.jobs).some((job) =>
        job.steps.some(
          (step) => step.run === "npm run build --workspace @zen/zenx",
        ),
      ),
      file,
    );
  }
});

test("file navigation still builds all native bridge outputs and retains its real capture command", async () => {
  const workflow = parse(
    await read(".github/workflows/file-end-navigation.yml"),
  );
  const steps = workflow.jobs["native-navigation"].steps;
  assert.ok(
    steps.some(
      (s) =>
        s.run ===
        'npm --workspace apps/zenx run build:fixtures\nnode apps/zenx/scripts/build-file-sidebar-preview.mjs "${{ runner.temp }}/zenx-end-navigation"\n',
    ),
  );
  assert.ok(
    steps.some((s) =>
      s.run?.includes(
        'npx --no-install electron scripts/capture-file-sidebar-electron.cjs "${{ runner.temp }}/zenx-end-navigation" --scope=end-navigation',
      ),
    ),
  );
  const capture = await read(
    "apps/zenx/scripts/capture-file-sidebar-electron.cjs",
  );
  assert.match(capture, /out[/\\]main[/\\]renderer-file-protocol/u);
});

test("packaging always prepares and includes independently verified RTK resources", async () => {
  const source = await read("apps/zenx/scripts/package-zenx-portable.mjs");
  assert.match(
    source,
    /await packZenXFirstPartyPlugins\(\{ outputDirectory: resources \}\)/u,
  );
  assert.match(
    source,
    /const hasRtk = await prepareRtkResource\(\{\s*resourcesDirectory: resources,/u,
  );
  assert.match(source, /path\.join\(resources, "rtk"\)/u);
  const rtk = await read("apps/zenx/scripts/prepare-rtk.mjs");
  assert.match(rtk, /expectedArchiveSha256 = RTK_ARCHIVE_SHA256/u);
  assert.match(rtk, /expectedBinarySha256 = RTK_BINARY_SHA256/u);
  assert.match(rtk, /RTK binary checksum mismatch/u);
});

test("actual npm lifecycle excludes failing RTK only for fixtures; default build/dev still fail before compilation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-fixture-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "calls.txt");
  const runner = path.join(root, "leaf.cjs");
  await writeFile(
    runner,
    `require('node:fs').appendFileSync(process.env.CALLS,process.argv[2]+'\\n');if(process.argv[2]==='rtk')process.exit(23);`,
  );
  const leaves = {
    "prepare:first-party-plugins": "node leaf.cjs plugins",
    "prepare:rtk": "node leaf.cjs rtk",
    "build:prepared": "node leaf.cjs bundle",
    build: "node leaf.cjs bundle",
    dev: "node leaf.cjs dev",
  };
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "synthetic-lifecycle-only",
      version: "1.0.0",
      scripts: {
        ...Object.fromEntries(
          ["prebuild", "predev", "prebuild:fixtures", "build:fixtures"].map(
            (k) => [k, scripts[k]],
          ),
        ),
        ...leaves,
      },
    }),
  );
  const env = {
    ...process.env,
    CALLS: marker,
    npm_config_cache: path.join(root, "npm-cache"),
    npm_config_update_notifier: "false",
  };
  for (const name of ["build:fixtures", "build", "dev"]) {
    await writeFile(marker, "");
    const result = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["run", name],
      {
        cwd: root,
        env,
        encoding: "utf8",
        shell: process.platform === "win32",
        timeout: 30000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(
      result.status === 0,
      name === "build:fixtures",
      result.stdout + result.stderr,
    );
    assert.equal(
      await readFile(marker, "utf8"),
      name === "build:fixtures" ? "plugins\nbundle\n" : "plugins\nrtk\n",
    );
  }
});
