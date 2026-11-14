import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  baselineTests,
  classifyRisk,
  rendererNativeBridgePaths,
  lanes,
  planDigest,
  selectRisk,
} from "../ci-risk-selection.mjs";
import { runQuickTests } from "../run-ci-quick-tests.mjs";
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "ci-risk-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...a) =>
    execFileSync("git", a, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  const put = (p, s = "// fixture\n") => {
    mkdirSync(dirname(join(cwd, p)), { recursive: true });
    writeFileSync(join(cwd, p), s);
  };
  const commit = () => {
    git("add", ".");
    git("commit", "--allow-empty", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  for (const p of baselineTests) put(p);
  put("docs/a.md");
  put("apps/mobile/src/session.mjs");
  put("apps/zenx/src/renderer/src/App.tsx");
  put("apps/zenx/src/main/capabilities/user-browser-provider.ts");
  const base = commit();
  const options = (head, extra = {}) => ({
    event: "pull_request",
    base,
    head,
    checkout: head,
    cwd,
    runId: "123",
    runAttempt: "2",
    ...extra,
  });
  return {
    cwd,
    git,
    put,
    commit,
    base,
    options,
    select: (h, e) => selectRisk(options(h, e)),
  };
}
const runs = (r) => lanes.filter((l) => r.modes[l] === "run");
const roomFileTests = [
  "apps/zenx/test/room-file-owner-labels.test.ts",
  "apps/zenx/test/room-file-owner-tabs.test.ts",
];
test("Room renderer sources select both owner-label and mounted-routing units", (t) => {
  for (const source of [
    "apps/zenx/src/renderer/src/room-file-owner-labels.ts",
    "apps/zenx/src/renderer/src/auxiliary-panel.tsx",
    "apps/zenx/src/renderer/src/styles.css",
  ]) {
    const f = fixture(t);
    f.put(source);
    const report = f.select(f.commit());
    for (const file of roomFileTests)
      assert.equal(
        report.quickTests.filter((path) => path === file).length,
        1,
        source,
      );
    assert.deepEqual(runs(report), ["quick", ...classifyRisk(source).lanes]);
    assert.equal(report.modes.aggregate, "omit-pr-risk");
  }
});

test("different integration tree retains both Room units in the conservative fallback", (t) => {
  const f = fixture(t);
  f.put("apps/zenx/src/renderer/src/room-file-owner-labels.ts");
  const head = f.commit();
  f.put("integration-only.txt");
  const checkout = f.commit();
  const report = f.select(head, { checkout });
  assert.match(
    report.reasons.join("\n"),
    /Integration tree differs from selected head/,
  );
  for (const file of [
    ...baselineTests,
    ...roomFileTests,
    "apps/zenx/test/shell-panel-renderer.test.ts",
    "apps/zenx/test/browser-targeted-input.test.ts",
    "apps/mobile/test/session.test.mjs",
  ])
    assert.ok(report.quickTests.includes(file), file);
  assert.deepEqual(
    runs(report),
    lanes.filter((lane) => lane !== "aggregate"),
  );
});

test("unrelated mobile/browser and docs plans do not gain Room units or different lanes", (t) => {
  for (const source of [
    "apps/mobile/src/session.mjs",
    "apps/zenx/src/main/capabilities/user-browser-provider.ts",
    "docs/a.md",
  ]) {
    const f = fixture(t);
    f.put(source, "// edit\n");
    const report = f.select(f.commit());
    for (const file of roomFileTests)
      assert.ok(!report.quickTests.includes(file), source);
    assert.deepEqual(
      runs(report),
      source.startsWith("docs/")
        ? []
        : ["quick", ...classifyRisk(source).lanes],
    );
  }
});

test("the bound quick runner dispatches both Room units without filters and preserves failure", (t) => {
  const f = fixture(t);
  f.put("apps/zenx/src/renderer/src/room-file-owner-labels.ts");
  const head = f.commit();
  const report = f.select(head);
  // The runner's existence check is real; child execution is injected solely
  // to inspect its exact argv, not to claim these product tests executed here.
  for (const file of report.quickTests) f.put(file);
  const destination = join(f.cwd, "receipt.json");
  let argv;
  const status = runQuickTests(destination, {
    cwd: f.cwd,
    env: {
      GITHUB_EVENT_NAME: "pull_request",
      CI_BASE_SHA: f.base,
      CI_HEAD_SHA: head,
      CI_CHECKOUT_SHA: head,
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "2",
      CI_PLAN_DIGEST: planDigest(report),
    },
    spawn: (_command, args) => {
      argv = args;
      return { status: 1 };
    },
  });
  assert.equal(status, 1);
  assert.deepEqual(argv, ["--import", "tsx", "--test", ...report.quickTests]);
  for (const file of roomFileTests) assert.ok(argv.includes(file));
  assert.equal(JSON.parse(readFileSync(destination)).exitCode, 1);
});

test("risk policy covers ordinary ready and draft PRs identically, not by draft status", (t) => {
  const f = fixture(t);
  f.put("apps/mobile/src/session.mjs", "// edit\n");
  const h = f.commit();
  for (const draft of [true, false, undefined]) {
    const r = f.select(h, { draft });
    assert.equal(r.tier, "pr-risk");
    assert.deepEqual(runs(r), ["quick", "android"]);
    assert.ok(r.quickTests.includes("apps/mobile/test/session.test.mjs"));
  }
});
test("renderer code selects UI without running full aggregate or unrelated platforms", (t) => {
  const f = fixture(t);
  f.put("apps/zenx/src/renderer/src/App.tsx", "// edit\n");
  const r = f.select(f.commit());
  assert.deepEqual(runs(r), ["quick", "ui"]);
  assert.ok(
    r.quickTests.includes("apps/zenx/test/inline-reference-codec.test.ts"),
  );
});
test("browser/native/packaging policies preserve the relevant actual platforms", () => {
  for (const [p, expected] of [
    [
      "apps/zenx/src/main/capabilities/user-browser-provider.ts",
      ["windows-browser", "playwright"],
    ],
    [
      "apps/zenx/src/main/capabilities/windows-computer-provider.ts",
      ["windows-computer", "windows-packaged", "windows-browser"],
    ],
    ["apps/zenx/src/main/app-shot-macos.ts", ["capability", "playwright"]],
    [
      "apps/zenx/scripts/package-zenx-portable.mjs",
      [
        "ui",
        "capability",
        "windows-computer",
        "windows-packaged",
        "windows-browser",
        "playwright",
      ],
    ],
  ])
    assert.deepEqual(classifyRisk(p).lanes, expected, p);
  for (const p of [
    "new-root/anything.ts",
    "apps/zenx/src/main/new-system/unknown.ts",
    "package-lock.json",
    "src/protocol/native/remote-wire.ts",
    "packages/zenx-plugin-sdk/src/index.ts",
    "packages/zenx-imzenx-plugin/src/index.ts",
  ])
    assert.equal(classifyRisk(p).lanes.length, lanes.length - 1, p);
});
test("heterogeneous changes union risk lanes, without promoting PRs to full aggregate", (t) => {
  const f = fixture(t);
  f.put("apps/mobile/src/session.mjs", "// edit\n");
  f.put(
    "apps/zenx/src/main/capabilities/user-browser-provider.ts",
    "// edit\n",
  );
  f.put("apps/zenx/src/renderer/src/App.tsx", "// edit\n");
  assert.deepEqual(runs(f.select(f.commit())), [
    "quick",
    "ui",
    "windows-browser",
    "playwright",
    "android",
  ]);
});
test("docs stay format-only; main/manual and unknown events remain genuinely full", (t) => {
  const f = fixture(t);
  f.put("docs/a.md", "changed\n");
  const h = f.commit();
  assert.equal(f.select(h).tier, "documentation");
  assert.deepEqual(runs(f.select(h)), []);
  for (const event of [
    "push",
    "workflow_dispatch",
    "release",
    "merge_group",
    undefined,
  ])
    assert.deepEqual(runs(f.select(h, { event })), lanes);
});
test("missing range, nonordinary mode and integration mismatch retain all PR risks", (t) => {
  const f = fixture(t);
  f.put("apps/mobile/src/session.mjs", "// edit\n");
  const h = f.commit();
  for (const extra of [
    { base: "a".repeat(40) },
    { checkout: "bad" },
    { base: h },
  ])
    assert.equal(runs(f.select(h, extra)).length, lanes.length - 1);
  chmodSync(join(f.cwd, "apps/mobile/src/session.mjs"), 0o755);
  assert.equal(runs(f.select(f.commit())).length, lanes.length - 1);
});
test("new, deleted and renamed test files cannot silently reduce risk coverage", (t) => {
  for (const mutate of [
    (f) => f.put("apps/zenx/test/new.test.ts"),
    (f) => rmSync(join(f.cwd, baselineTests[3])),
    (f) =>
      renameSync(
        join(f.cwd, baselineTests[3]),
        join(f.cwd, "apps/zenx/test/renamed.test.mjs"),
      ),
  ]) {
    const f = fixture(t);
    mutate(f);
    const r = f.select(f.commit());
    assert.equal(runs(r).length, lanes.length - 1);
    assert.match(r.reasons.join(" "), /New\/deleted\/renamed test/);
  }
});
test("changed existing tests are added once, and deleted source paths retain their domain", (t) => {
  const f = fixture(t);
  f.put(baselineTests[3], "// edit\n");
  rmSync(join(f.cwd, "apps/mobile/src/session.mjs"));
  const r = f.select(f.commit());
  assert.equal(r.quickTests.filter((p) => p === baselineTests[3]).length, 1);
  assert.equal(r.modes.android, "run");
});
test("quick runner binds source/run plan, supports partial reruns and preserves failure", (t) => {
  const f = fixture(t);
  f.put(baselineTests[3], "// edit\n");
  const head = f.commit(),
    report = f.select(head);
  const env = {
    GITHUB_EVENT_NAME: "pull_request",
    CI_BASE_SHA: f.base,
    CI_HEAD_SHA: head,
    CI_CHECKOUT_SHA: head,
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "2",
    CI_PLAN_DIGEST: planDigest(report),
  };
  for (const status of [0, 1, null]) {
    const dest = join(tmpdir(), `risk-receipt-${process.pid}-${status}.json`);
    t.after(() => rmSync(dest, { force: true }));
    rmSync(dest, { force: true });
    let args;
    assert.equal(
      runQuickTests(dest, {
        cwd: f.cwd,
        env,
        spawn: (_cmd, a) => {
          args = a;
          return { status };
        },
      }),
      status === 0 ? 0 : 1,
    );
    assert.deepEqual(args, ["--import", "tsx", "--test", ...report.quickTests]);
    assert.equal(JSON.parse(readFileSync(dest)).exitCode, status);
  }
  const rerunReceipt = join(tmpdir(), `risk-rerun-${process.pid}.json`);
  rmSync(rerunReceipt, { force: true });
  t.after(() => rmSync(rerunReceipt, { force: true }));
  assert.equal(
    runQuickTests(rerunReceipt, {
      cwd: f.cwd,
      env: { ...env, GITHUB_RUN_ATTEMPT: "3" },
      spawn: () => ({ status: 0 }),
    }),
    0,
  );
  assert.equal(JSON.parse(readFileSync(rerunReceipt)).runAttempt, "3");
  assert.throws(
    () =>
      runQuickTests("unused", {
        cwd: f.cwd,
        env: { ...env, GITHUB_RUN_ID: "999" },
      }),
    /current-run/,
  );
  assert.throws(
    () =>
      runQuickTests("unused", {
        cwd: f.cwd,
        env: { ...env, CI_PLAN_DIGEST: "" },
      }),
    /current-run/,
  );
});
test("CLI emits complete typed mode tokens, never false/unknown omission flags", (t) => {
  const f = fixture(t);
  f.put("apps/mobile/src/session.mjs", "// edit\n");
  const head = f.commit();
  const out = join(tmpdir(), `risk-output-${process.pid}`),
    report = out + ".json";
  t.after(() => {
    rmSync(out, { force: true });
    rmSync(report, { force: true });
  });
  rmSync(out, { force: true });
  execFileSync(
    process.execPath,
    [new URL("../ci-risk-selection.mjs", import.meta.url).pathname, report],
    {
      cwd: f.cwd,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "pull_request",
        CI_BASE_SHA: f.base,
        CI_HEAD_SHA: head,
        CI_CHECKOUT_SHA: head,
        GITHUB_OUTPUT: out,
      },
    },
  );
  const s = readFileSync(out, "utf8");
  assert.match(s, /tier=pr-risk/);
  assert.match(s, /android-mode=run/);
  assert.match(s, /aggregate-mode=omit-pr-risk/);
  for (const lane of lanes)
    assert.match(s, new RegExp(`${lane}-mode=(?:run|omit-pr-risk)\\n`));
});

test("renderer native/browser/shell bridge changes retain native lanes and security units", (t) => {
  for (const file of rendererNativeBridgePaths) {
    const result = classifyRisk(file);
    assert.equal(result.domain, "renderer-native");
    for (const lane of [
      "ui",
      "capability",
      "windows-computer",
      "windows-packaged",
      "windows-browser",
      "playwright",
    ])
      assert.ok(result.lanes.includes(lane), `${file}: ${lane}`);
  }
  const f = fixture(t);
  f.put("apps/zenx/src/renderer/src/shell-terminal-security.ts");
  const report = f.select(f.commit());
  assert.ok(
    report.quickTests.includes("apps/zenx/test/shell-panel-renderer.test.ts"),
  );
  assert.ok(
    report.quickTests.includes("apps/zenx/test/native-view-overlays.test.ts"),
  );
});

test("shared/unknown and test inventory changes include every domain quick set", (t) => {
  for (const path of [
    "src/new-shared.ts",
    "unrecognized/new.ts",
    "apps/zenx/test/new-risk.test.ts",
  ]) {
    const f = fixture(t);
    f.put(path);
    const report = f.select(f.commit());
    for (const file of [
      "apps/mobile/test/session.test.mjs",
      "apps/zenx/test/browser-targeted-input.test.ts",
      "apps/zenx/test/shell-panel-renderer.test.ts",
      "apps/zenx/test/first-party-plugin-packaging.test.mjs",
      "apps/zenx/test/inline-reference-codec.test.ts",
    ])
      assert.ok(report.quickTests.includes(file), `${path}: ${file}`);
  }
});
