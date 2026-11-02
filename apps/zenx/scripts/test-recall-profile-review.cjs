/** Fixture-only publication boundary tests; no Electron, credentials or network. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { test } = require("node:test");

async function fixture() {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "zen-profile-review-unit-"),
  );
  await fs.chmod(temporary, 0o700);
  const directory = path.join(temporary, "upload");
  await fs.mkdir(directory);
  const runtime = path.join(temporary, "profile/runtime");
  await fs.mkdir(runtime, { recursive: true });
  const tokenPath = path.join(runtime, "app-server.token");
  const token = "a".repeat(64); // Deliberately synthetic, never a runtime credential.
  await fs.writeFile(tokenPath, token + "\n", { mode: 0o600 });
  const configPath = path.join(temporary, "profile/host-profile.json");
  const config = JSON.stringify({
    fixture: true,
    label: "synthetic-private-config",
  });
  await fs.writeFile(configPath, config, { mode: 0o600 });
  const rawPath = path.join(
    temporary,
    "owned-native-send-profile.private.json",
  );
  const raw = JSON.stringify({
    traceEvents: [{ name: "SyntheticPhase", ts: 1 }],
  });
  await fs.writeFile(rawPath, raw, { mode: 0o600 });
  const source = await fs.readFile(
    path.join(__dirname, "capture-recall-send-profile.cjs"),
    "utf8",
  );
  const code = source.slice(
    source.indexOf("function profileReviewReasons("),
    source.indexOf("\nasync function run()"),
  );
  const result = { profile: {} };
  const context = vm.createContext({
    assert,
    fs,
    path,
    temporary,
    directory,
    result,
    process: { cwd: () => temporary },
  });
  vm.runInContext(code, context);
  return {
    temporary,
    directory,
    runtime,
    tokenPath,
    token,
    configPath,
    config,
    rawPath,
    raw,
    result,
    run: () => context.reviewAndPublishProfile(rawPath),
    cleanup: () => fs.rm(temporary, { recursive: true, force: true }),
  };
}

test("safe raw trace is copied only to the explicit reviewed filename", async () => {
  const f = await fixture();
  try {
    await f.run();
    assert.equal(f.result.profile.review.passed, true);
    assert.equal(f.result.profile.review.knownCredentialCount, 1);
    assert.deepEqual(await fs.readdir(f.directory), [
      "owned-native-send-profile.reviewed.json",
    ]);
    assert.equal(
      await fs.readFile(
        path.join(f.directory, "owned-native-send-profile.reviewed.json"),
        "utf8",
      ),
      f.raw,
    );
    assert.equal(await fs.readFile(f.rawPath, "utf8"), f.raw);
    assert.equal(JSON.stringify(f.result).includes(f.token), false);
  } finally {
    await f.cleanup();
  }
});

const failures = {
  "required token missing": (f) => fs.rm(f.tokenPath),
  "required token malformed": (f) =>
    fs.writeFile(f.tokenPath, "not-a-token-".repeat(8)),
  "required token contains extra line": (f) =>
    fs.writeFile(f.tokenPath, f.token + "\nextra\n"),
  "required token symlink": async (f) => {
    const target = path.join(f.runtime, "target");
    await fs.rename(f.tokenPath, target);
    await fs.symlink(target, f.tokenPath);
  },
  "required token hardlink": (f) =>
    fs.link(f.tokenPath, path.join(f.runtime, "alias")),
  "optional token malformed": (f) =>
    fs.writeFile(path.join(f.runtime, "plugin-dev.token"), "bad"),
  "optional token is directory": (f) =>
    fs.mkdir(path.join(f.runtime, "plugin-dev.token")),
  "known token in raw": (f) =>
    fs.writeFile(f.rawPath, JSON.stringify({ leak: f.token })),
  "private configuration in raw": (f) =>
    fs.writeFile(f.rawPath, JSON.stringify({ leak: f.config })),
  "nonfixture user path in raw": (f) =>
    fs.writeFile(
      f.rawPath,
      JSON.stringify({ file: "/Users/private-user/Documents/private.txt" }),
    ),
  "generic bearer in raw": (f) =>
    fs.writeFile(
      f.rawPath,
      JSON.stringify({ leak: "Bearer syntheticNeverValidCredential0000" }),
    ),
  "malformed private config cannot escape through diagnostics": (f) =>
    fs.writeFile(f.configPath, '{"secret":"synthetic-do-not-publish"'),
};

for (const [name, mutate] of Object.entries(failures)) {
  test(
    name + " fails closed with no uploadable trace and no leaked error detail",
    async () => {
      const f = await fixture();
      try {
        await mutate(f);
        const original = await fs.readFile(f.rawPath, "utf8");
        await assert.rejects(f.run(), {
          message: "Profile review failed; raw trace remains private",
        });
        assert.equal(f.result.profile.review.passed, false);
        assert.deepEqual(await fs.readdir(f.directory), []);
        assert.equal(await fs.readFile(f.rawPath, "utf8"), original);
        const report = JSON.stringify(f.result);
        assert.equal(report.includes(f.token), false);
        assert.equal(report.includes("synthetic-do-not-publish"), false);
        assert.equal(report.includes("private-user"), false);
      } finally {
        await f.cleanup();
      }
    },
  );
}
