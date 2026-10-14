import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildDownstream,
  parseFeatureContract,
  validateBuildLock,
  verifyAndPatchSource,
} from "../../../scripts/build-zenx-winapp-downstream.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const lock = JSON.parse(
  await readFile(
    path.join(root, "vendor/winapp-0.3.1/source.lock.json"),
    "utf8",
  ),
);
const patch = await readFile(path.join(root, lock.patch.path), "utf8");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const git = (directory, ...args) =>
  execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

async function fixture(t) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-winapp-source-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source");
  await mkdir(source);
  const contents = new Map();
  let current;
  for (const line of patch.split("\n")) {
    if (line.startsWith("--- a/")) {
      current = line.slice(6);
      contents.set(current, []);
    } else if (line.startsWith("@@ ")) {
      const start = Number(line.match(/^@@ -(\d+)/u)[1]);
      const lines = contents.get(current);
      while (lines.length < start - 1)
        lines.push(`// unchanged fixture line ${lines.length + 1}`);
    } else if (
      current &&
      (line === "" ||
        line.startsWith(" ") ||
        (line.startsWith("-") && !line.startsWith("---")))
    ) {
      contents.get(current).push(line.slice(1));
    }
  }
  for (const [name, lines] of contents) {
    const file = path.join(source, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${lines.join("\n")}\n`);
  }
  git(source, "init");
  git(source, "config", "core.autocrlf", "false");
  git(source, "add", ".");
  git(
    source,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "fixture preimages",
  );
  const fixtureLock = structuredClone(lock);
  fixtureLock.upstream.commit = git(source, "rev-parse", "HEAD");
  for (const name of Object.keys(fixtureLock.sourceFiles))
    fixtureLock.sourceFiles[name] = git(source, "rev-parse", `HEAD:${name}`);
  return { directory, source, lock: fixtureLock };
}

test("downstream source, patch and toolchain pins agree with the isolated workflow", async () => {
  validateBuildLock(lock);
  assert.equal(digest(patch), lock.patch.sha256);
  assert.equal(
    lock.upstream.commit,
    "c8ada4a403c43b96780b87abc454cba51f649c60",
  );
  const workflow = await readFile(
    path.join(root, ".github/workflows/zenx-winapp-downstream.yml"),
    "utf8",
  );
  assert.ok(workflow.includes(`ref: ${lock.upstream.commit}`));
  assert.ok(workflow.includes(`dotnet-version: ${lock.dotnetSdk}`));
  assert.ok(workflow.includes(`node-version: ${lock.nodeVersion}`));
  assert.ok(
    workflow.includes(
      "DOTNET_INSTALL_DIR: ${{ runner.temp }}/zenx-dotnet-candidate",
    ),
  );
  assert.equal(lock.dependencyLockMode, "capture-then-locked-restore");
});

test("runner-local SDK path uses a supported step context instead of job env", async () => {
  const workflow = await readFile(
    path.join(root, ".github/workflows/zenx-winapp-downstream.yml"),
    "utf8",
  );
  for (const ending of ["\n", "\r\n"]) {
    const text = workflow.replace(/\r?\n/gu, ending).replace(/\r\n/gu, "\n");
    const [jobConfiguration, steps] = text.split("    steps:\n");
    assert.doesNotMatch(jobConfiguration, /\$\{\{\s*runner\./u);
    const setupDotnet = steps
      .split(/(?=^      - )/mu)
      .find((step) => step.includes("uses: actions/setup-dotnet@"));
    assert.ok(setupDotnet);
    assert.match(
      setupDotnet,
      /        env:\n          DOTNET_INSTALL_DIR: \$\{\{ runner\.temp \}\}\/zenx-dotnet-candidate\n/u,
    );
  }
});

test("Windows-style fresh clone preserves the exact hashed patch bytes", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-winapp-eol-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source");
  const checkout = path.join(directory, "checkout");
  const patchFile = path.join(source, lock.patch.path);
  await mkdir(path.dirname(patchFile), { recursive: true });
  await writeFile(patchFile, patch);
  await writeFile(
    path.join(source, ".gitattributes"),
    await readFile(path.join(root, ".gitattributes")),
  );
  git(source, "init");
  git(source, "config", "core.autocrlf", "false");
  git(source, "add", ".");
  git(
    source,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "patch bytes",
  );
  git(
    directory,
    "-c",
    "core.autocrlf=true",
    "clone",
    "--no-local",
    source,
    checkout,
  );
  const checkedOut = await readFile(path.join(checkout, lock.patch.path));
  assert.equal(digest(checkedOut), lock.patch.sha256);
  assert.equal(checkedOut.toString("utf8"), patch);
});

test("SDK runtime resolution is bound to the same framework, RID and version before build", async () => {
  const { getBuildProperties, parseRuntimeResolution } =
    await import("../../../scripts/build-zenx-winapp-downstream.mjs");
  assert.equal(typeof getBuildProperties, "function");
  assert.equal(typeof parseRuntimeResolution, "function");
  const properties = getBuildProperties(lock);
  assert.ok(properties.includes("-p:TargetLatestRuntimePatch=true"));
  assert.ok(properties.includes(`-p:RuntimeIdentifier=${lock.targetRid}`));
  assert.ok(properties.includes("-p:Configuration=Release"));
  assert.ok(properties.includes("-p:SelfContained=true"));
  assert.ok(
    properties.every((value) => !value.includes("RuntimeFrameworkVersion=")),
  );
  const resolution = {
    Properties: {
      TargetFramework: "net10.0-windows10.0.19041.0",
      RuntimeIdentifier: "win-x64",
      SelfContained: "true",
      PublishAot: "true",
    },
    Items: {
      RuntimeFramework: [
        { Identity: "Microsoft.NETCore.App", Version: "10.0.12" },
      ],
      RuntimePack: [
        {
          Identity: "Microsoft.NETCore.App.Runtime.win-x64",
          FrameworkName: "Microsoft.NETCore.App",
          RuntimeIdentifier: "win-x64",
          NuGetPackageVersion: "10.0.12",
        },
      ],
    },
  };
  assert.equal(
    parseRuntimeResolution(JSON.stringify(resolution), lock).runtimeVersion,
    "10.0.12",
  );
  const changes = [
    (r) => {
      r.Properties.TargetFramework = "net10.0";
    },
    (r) => {
      r.Properties.RuntimeIdentifier = "win-arm64";
    },
    (r) => {
      r.Properties.SelfContained = "false";
    },
    (r) => {
      r.Properties.PublishAot = "false";
    },
    (r) => {
      r.Items.RuntimeFramework[0].Version = "10.0.11";
    },
    (r) => {
      r.Items.RuntimePack[0].NuGetPackageVersion = "10.0.13";
    },
    (r) => {
      r.Items.RuntimePack[0].RuntimeIdentifier = "win-arm64";
    },
    (r) => {
      r.Items.RuntimePack = [];
    },
    (r) => {
      r.Items.RuntimePack.push({ ...r.Items.RuntimePack[0] });
    },
  ];
  for (const change of changes) {
    const invalid = structuredClone(resolution);
    change(invalid);
    assert.throws(() => parseRuntimeResolution(JSON.stringify(invalid), lock));
  }
});

test("patch uses generated UIA2 and confirms FALSE on the real service before retaining its client", () => {
  assert.match(patch, /\+IUIAutomation2/u);
  assert.ok(
    patch.indexOf("automation.put_AutoSetFocus(false)") <
      patch.indexOf("if (automation.get_AutoSetFocus())"),
  );
  assert.ok(
    patch.indexOf("if (automation.get_AutoSetFocus())") <
      patch.indexOf("_automation = automation;"),
  );
  assert.match(patch, /GetRequiredService<IUiAutomationService>/u);
  assert.match(patch, /uia\.ZenXAutoSetFocus/u);
  assert.doesNotMatch(
    patch,
    /GetDelegateForFunctionPointer|ReadIntPtr|\bSetFocus\(\)|SendInput\(/u,
  );
});

test("real Git applies only reviewed source paths and rejects reuse of a dirty build checkout", async (t) => {
  const f = await fixture(t);
  const result = await verifyAndPatchSource({
    root,
    sourceDirectory: f.source,
    lock: f.lock,
  });
  assert.deepEqual(result.patchedPaths, Object.keys(lock.sourceFiles).sort());
  const service = await readFile(
    path.join(
      f.source,
      "src/winapp-CLI/WinApp.Cli/Services/UiAutomationService.cs",
    ),
    "utf8",
  );
  assert.match(service, /CreateInstance<IUIAutomation2>\(\)/u);
  assert.match(service, /automation\.put_AutoSetFocus\(false\)/u);
  assert.equal(git(f.source, "diff", "--name-only"), "");
  await assert.rejects(
    verifyAndPatchSource({ root, sourceDirectory: f.source, lock: f.lock }),
    /must be clean/u,
  );
});

test("patch tampering is rejected before any source command", async () => {
  const bad = structuredClone(lock);
  bad.patch.sha256 = "0".repeat(64);
  let called = false;
  await assert.rejects(
    verifyAndPatchSource({
      root,
      sourceDirectory: root,
      lock: bad,
      execute: () => {
        called = true;
        throw new Error("unexpected command");
      },
    }),
    /patch hash mismatch/u,
  );
  assert.equal(called, false);
});

test("wrong source commit, dirty worktree and changed preimage fail before patching", async (t) => {
  const f = await fixture(t);
  const wrongCommit = structuredClone(f.lock);
  wrongCommit.upstream.commit = "0".repeat(40);
  await assert.rejects(
    verifyAndPatchSource({
      root,
      sourceDirectory: f.source,
      lock: wrongCommit,
    }),
    /source commit/u,
  );
  const wrongPreimage = structuredClone(f.lock);
  wrongPreimage.sourceFiles[Object.keys(wrongPreimage.sourceFiles)[0]] =
    "0".repeat(40);
  await assert.rejects(
    verifyAndPatchSource({
      root,
      sourceDirectory: f.source,
      lock: wrongPreimage,
    }),
    /preimage mismatch/u,
  );
  await writeFile(path.join(f.source, "unreviewed.txt"), "dirty");
  await assert.rejects(
    verifyAndPatchSource({ root, sourceDirectory: f.source, lock: f.lock }),
    /must be clean/u,
  );
  assert.equal(git(f.source, "diff", "--cached", "--name-only"), "");
});

test("extra patch paths are rejected before materializing them", async (t) => {
  const f = await fixture(t);
  const modified = `${patch}--- /dev/null\n+++ b/unreviewed.txt\n@@ -0,0 +1 @@\n+unreviewed\n`;
  const fakeRoot = path.join(f.directory, "fake-root");
  await mkdir(path.join(fakeRoot, path.dirname(lock.patch.path)), {
    recursive: true,
  });
  await writeFile(path.join(fakeRoot, lock.patch.path), modified);
  f.lock.patch.sha256 = digest(modified);
  await assert.rejects(
    verifyAndPatchSource({
      root: fakeRoot,
      sourceDirectory: f.source,
      lock: f.lock,
    }),
    /unreviewed path/u,
  );
  await assert.rejects(access(path.join(f.source, "unreviewed.txt")));
});

test("feature evidence requires the exact downstream identity and actual boolean FALSE", () => {
  const contract = {
    schemaVersion: 1,
    providerBuild: lock.downstream.providerBuild,
    upstreamCommit: lock.upstream.commit,
    autoSetFocus: false,
  };
  assert.deepEqual(
    parseFeatureContract(JSON.stringify(contract), lock),
    contract,
  );
  for (const change of [
    { autoSetFocus: true },
    { autoSetFocus: 0 },
    { providerBuild: "stock-winapp" },
    { upstreamCommit: "0".repeat(40) },
    { schemaVersion: 2 },
    { backgroundSafeForAllApps: true },
  ]) {
    assert.throws(() =>
      parseFeatureContract(JSON.stringify({ ...contract, ...change }), lock),
    );
  }
  assert.throws(() => parseFeatureContract("{}", lock));
  assert.throws(() => parseFeatureContract("notice\n{}", lock));
});

test("source lock refuses path escapes and unsupported architecture", () => {
  for (const mutation of [
    (x) => {
      x.patch.path = "../outside.patch";
    },
    (x) => {
      x.project = "/absolute.csproj";
    },
    (x) => {
      x.targetRid = "win-arm64";
    },
  ]) {
    const value = structuredClone(lock);
    mutation(value);
    assert.throws(() => validateBuildLock(value));
  }
});

test(
  "non-Windows cannot accidentally build or select a runtime helper",
  { skip: process.platform === "win32" },
  async () => {
    await assert.rejects(buildDownstream({}), /require Windows/u);
  },
);
