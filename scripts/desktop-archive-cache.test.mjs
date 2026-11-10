import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  archivePlan,
  runArchiveCache,
  verifyArchive,
} from "./desktop-archive-cache.mjs";

const source = path.resolve(import.meta.dirname, "..");
const bytes = Buffer.from("synthetic archive; never extracted or executed");
const sha = createHash("sha256").update(bytes).digest("hex");
// Fixtures must never inherit a hosted job's cache root or append temporary
// paths/outputs into the real runner's environment, output or summary files.
function fixtureEnvironment(inherited = process.env) {
  const env = { ...inherited };
  for (const key of [
    "electron_config_cache",
    "GITHUB_ENV",
    "GITHUB_OUTPUT",
    "GITHUB_STEP_SUMMARY",
  ])
    delete env[key];
  return env;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "desktop-archives-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "scripts"));
  const lock = JSON.parse(
    await readFile(
      path.join(source, "scripts/desktop-archives.lock.json"),
      "utf8",
    ),
  );
  for (const key of Object.keys(lock.electron.checksums))
    lock.electron.checksums[key] = sha;
  lock.rtk.archiveSha256 = sha;
  const writeLock = () =>
    writeFile(
      path.join(root, "scripts/desktop-archives.lock.json"),
      JSON.stringify(lock),
    );
  await writeLock();
  await writeFile(
    path.join(root, "package-lock.json"),
    await readFile(path.join(source, "package-lock.json")),
  );
  return { root, lock, writeLock };
}
async function put(file, contents = bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

test("production plan works before installation and separates OS/arch/version/digest", async () => {
  const plans = await Promise.all(
    [
      ["linux", "x64"],
      ["darwin", "arm64"],
      ["darwin", "x64"],
      ["win32", "x64"],
    ].map(([platform, arch]) => archivePlan({ root: source, platform, arch })),
  );
  assert.equal(new Set(plans.map((p) => p.electron.key)).size, 4);
  assert.ok(plans[1].rtk);
  for (const p of [plans[0], plans[2], plans[3]])
    assert.equal(p.rtk, undefined);
  for (const p of plans) {
    assert.ok(p.electron.key.endsWith(p.electron.sha256));
    assert.ok(p.electron.file.endsWith(p.electron.filename));
    assert.ok(p.electron.authority.startsWith("npm-lock:sha512-"));
  }
});

test("missing authority, changed npm pin, unsupported target fail closed", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    archivePlan({ ...f, platform: "unknown" }),
    /Unsupported/,
  );
  delete f.lock.electron.checksums["electron-v43.2.0-linux-x64.zip"];
  await f.writeLock();
  await assert.rejects(
    archivePlan({ ...f, platform: "linux", arch: "x64" }),
    /Missing pinned/,
  );
  f.lock.electron.version = "43.3.0";
  await f.writeLock();
  await assert.rejects(archivePlan(f), /must match the npm lock/);
});

test("only exact complete hash-verified files are eligible; partial/transaction files cannot hit", async (t) => {
  const f = await fixture(t);
  const p = await archivePlan(f);
  await put(p.electron.file + ".partial");
  await put(
    path.join(path.dirname(p.electron.file), ".transaction", "archive"),
  );
  assert.deepEqual(await verifyArchive(p, p.electron), {
    verified: false,
    status: "miss",
  });
  await put(p.electron.file);
  assert.deepEqual(await verifyArchive(p, p.electron), {
    verified: true,
    status: "verified",
  });
  await put(p.electron.file, "corrupt");
  assert.equal((await verifyArchive(p, p.electron)).status, "rejected");
  assert.equal(
    (await verifyArchive(p, p.electron, { discardInvalid: true })).status,
    "rejected-and-removed",
  );
  assert.equal((await verifyArchive(p, p.electron)).status, "miss");
});

test("symlink archive or parent never becomes cache input", async (t) => {
  const f = await fixture(t);
  const p = await archivePlan(f);
  const other = path.join(f.root, "other");
  await put(other);
  await mkdir(path.dirname(p.electron.file), { recursive: true });
  await symlink(other, p.electron.file);
  await assert.rejects(verifyArchive(p, p.electron), /ordinary/);
  await rm(p.cacheRoot, { recursive: true });
  await mkdir(path.join(f.root, "outside"));
  await symlink(path.join(f.root, "outside"), p.cacheRoot, "dir");
  await assert.rejects(verifyArchive(p, p.electron), /ordinary/);
});

test("save requires installed Electron checksum authority, not just cache filename or npm success", async (t) => {
  const f = await fixture(t);
  const p = await archivePlan(f);
  await put(p.electron.file);
  await assert.rejects(
    verifyArchive(p, p.electron, { installedAuthority: true }),
    /ENOENT/,
  );
  await put(
    path.join(f.root, "node_modules/electron/package.json"),
    JSON.stringify({ version: p.electron.version }),
  );
  await put(
    path.join(f.root, "node_modules/electron/checksums.json"),
    JSON.stringify({ [p.electron.filename]: "0".repeat(64) }),
  );
  await assert.rejects(
    verifyArchive(p, p.electron, { installedAuthority: true }),
    /differs/,
  );
  await put(
    path.join(f.root, "node_modules/electron/checksums.json"),
    JSON.stringify({ [p.electron.filename]: sha }),
  );
  assert.equal(
    (await verifyArchive(p, p.electron, { installedAuthority: true })).verified,
    true,
  );
});

test("CLI plan exports installer cache before npm ci and reports byte validation separately", async (t) => {
  const f = await fixture(t);
  const env = {
    GITHUB_ENV: path.join(f.root, "env"),
    GITHUB_OUTPUT: path.join(f.root, "output"),
    GITHUB_STEP_SUMMARY: path.join(f.root, "summary"),
  };
  const logs = [];
  const output = await runArchiveCache("plan", {
    root: f.root,
    env,
    log: (m) => logs.push(m),
  });
  assert.equal(output["electron-verified"], "false");
  assert.match(
    await readFile(env.GITHUB_ENV, "utf8"),
    /electron_config_cache=.*\.packaged[/\\]cache[/\\]electron/u,
  );
  assert.match(logs[0], /planned.*authority=npm-lock/);
  const restored = await runArchiveCache("restored", {
    root: f.root,
    env,
    log: (m) => logs.push(m),
  });
  assert.equal(restored["electron-verified"], "false");
  assert.match(logs.at(-1), /miss/);
  await assert.rejects(
    runArchiveCache("plan", {
      root: f.root,
      env: { ELECTRON_MIRROR: "https://example.com" },
    }),
    /does not support/,
  );
});

test("checked-in Electron checksum projection equals the npm-installed authority for every supported ZIP", async () => {
  const lock = JSON.parse(
    await readFile(
      path.join(source, "scripts/desktop-archives.lock.json"),
      "utf8",
    ),
  );
  const installed = JSON.parse(
    await readFile(
      path.join(source, "node_modules/electron/checksums.json"),
      "utf8",
    ),
  );
  for (const [filename, checksum] of Object.entries(lock.electron.checksums)) {
    assert.match(
      filename,
      /^electron-v43\.2\.0-(darwin|linux|win32)-(arm64|armv7l|x64|ia32)\.zip$/u,
    );
    assert.equal(checksum, installed[filename], filename);
  }
});

test("digest change cannot hit an earlier key; malformed RTK authority is rejected", async (t) => {
  const f = await fixture(t);
  const before = await archivePlan({ ...f, platform: "darwin", arch: "arm64" });
  f.lock.rtk.archiveSha256 = "1".repeat(64);
  f.lock.electron.checksums[before.electron.filename] = "2".repeat(64);
  await f.writeLock();
  const after = await archivePlan({ ...f, platform: "darwin", arch: "arm64" });
  assert.notEqual(before.electron.key, after.electron.key);
  assert.notEqual(before.rtk.key, after.rtk.key);
  assert.notEqual(before.rtk.file, after.rtk.file);
  f.lock.rtk.url = "https://example.invalid/unapproved";
  await f.writeLock();
  await assert.rejects(archivePlan(f), /Invalid pinned RTK/);
});

test("preinstall CLI requires no installed modules and rejects all upstream mirror override spellings", async (t) => {
  const f = await fixture(t);
  const { spawnSync } = await import("node:child_process");
  const hostedFile = path.join(f.root, "hosted-env-sentinel");
  await writeFile(hostedFile, "hosted runner state must stay unchanged\n");
  const inherited = {
    ...process.env,
    electron_config_cache: path.join(
      f.root,
      "different-hosted-checkout",
      "cache",
    ),
    GITHUB_ENV: hostedFile,
    GITHUB_OUTPUT: hostedFile,
    GITHUB_STEP_SUMMARY: hostedFile,
  };
  const cli = spawnSync(
    process.execPath,
    [path.join(source, "scripts/desktop-archive-cache.mjs"), "plan"],
    { cwd: f.root, encoding: "utf8", env: fixtureEnvironment(inherited) },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(
    await readFile(hostedFile, "utf8"),
    "hosted runner state must stay unchanged\n",
  );
  for (const key of [
    "ELECTRON_CUSTOM_VERSION",
    "NPM_CONFIG_ELECTRON_MIRROR",
    "npm_config_electron_customdir",
    "npm_package_config_electron_customDir",
    "ELECTRON_INSTALL_ARCH",
    "electron_use_remote_checksums",
  ]) {
    await assert.rejects(
      runArchiveCache("plan", { root: f.root, env: { [key]: "override" } }),
      new RegExp(key),
    );
  }
  await assert.rejects(
    runArchiveCache("plan", {
      root: f.root,
      env: { electron_config_cache: "/different" },
    }),
    /cache root differs/,
  );
});

test("the locked Electron package installs lazily and absence is not a verified cache save", async (t) => {
  const manifest = JSON.parse(
    await readFile(
      path.join(source, "node_modules/electron/package.json"),
      "utf8",
    ),
  );
  assert.equal(manifest.version, "43.2.0");
  assert.equal(manifest.scripts?.postinstall, undefined);
  const entry = await readFile(
    path.join(source, "node_modules/electron/index.js"),
    "utf8",
  );
  assert.match(
    entry,
    /spawnSync\(process\.execPath, \[path\.join\(__dirname, 'install\.js'\)\]/u,
  );
  const f = await fixture(t);
  const logs = [];
  const output = await runArchiveCache("save", {
    root: f.root,
    env: {},
    log: (line) => logs.push(line),
  });
  assert.equal(output["electron-verified"], "false");
  assert.match(logs[0], /archive save: miss/u);
  await assert.rejects(readFile(output["electron-path"]), /ENOENT/u);
});
