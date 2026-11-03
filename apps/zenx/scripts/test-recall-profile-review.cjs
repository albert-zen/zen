/** Fixture-only publication boundary tests; no Electron, credentials or network. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { test } = require("node:test");
const { summarizeSendTimeline } = require("./summarize-send-timeline.cjs");

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
    traceEvents: [
      {
        ph: "M",
        pid: 1,
        tid: 11,
        name: "thread_name",
        args: { name: "CrBrowserMain" },
      },
      {
        ph: "M",
        pid: 2,
        tid: 22,
        name: "thread_name",
        args: { name: "CrRendererMain" },
      },
      ...[0, 1, 2].flatMap((index) =>
        [
          "native-click",
          "geometry-complete",
          "next-frame-entry",
          "next-frame-geometry",
        ].map((phase, i) => ({
          ph: "I",
          pid: 2,
          tid: 22,
          name: `zen-send-${index}-${phase}`,
          ts: (100 + index * 100 + i * 10) * 1000,
        })),
      ),
    ],
  });
  await fs.writeFile(rawPath, raw, { mode: 0o600 });
  const source = await fs.readFile(
    path.join(__dirname, "capture-send-feedback-verified-frame.cjs"),
    "utf8",
  );
  const code = source.slice(
    source.indexOf("function profileReviewReasons("),
    source.indexOf("\nasync function run()"),
  );
  const result = {
    profile: { mainPid: 1, rendererPid: 2, bufferUsage: { percentage: 0.1 } },
    samples: [0, 1, 2].map((index) => ({
      clockDomain: "renderer",
      clickMs: 100 + index * 100,
      feedbackGeometryCompleteMs: 110 + index * 100,
      nextFrameEntryMs: 120 + index * 100,
      feedbackSubsequentFrameMs: 130 + index * 100,
    })),
  };
  const context = vm.createContext({
    assert,
    summarizeSendTimeline,
    fs,
    path,
    temporary,
    directory,
    result,
    process: { cwd: () => temporary },
    __dirname: path.join(temporary, "scripts"),
    createHash: require("node:crypto").createHash,
    pathToFileURL: require("node:url").pathToFileURL,
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
    run: (options) => context.reviewAndPublishProfile(rawPath, options),
    canReviewFirst: () => context.canReviewCompletedFirstTrace(result),
    cleanup: () => fs.rm(temporary, { recursive: true, force: true }),
  };
}

test("safe raw trace stays private; only bounded reviewed statistics are exported", async () => {
  const f = await fixture();
  try {
    await f.run();
    assert.equal(f.result.profile.review.passed, true);
    assert.equal(f.result.profile.review.knownCredentialCount, 1);
    assert.deepEqual(await fs.readdir(f.directory), [
      "owned-native-send-profile.summary.json",
    ]);
    const published = JSON.parse(
      await fs.readFile(
        path.join(f.directory, "owned-native-send-profile.summary.json"),
        "utf8",
      ),
    );
    assert.equal(published.diagnosticOnly, true);
    assert.equal(published.acceptance, false);
    assert.equal(published.samples.length, 3);
    assert.equal(published.traceEvents, undefined);
    assert.equal(JSON.stringify(published).includes(f.token), false);
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

test("invalid timeline reports a fixed summary stage without publishing raw or summary", async () => {
  const f = await fixture();
  try {
    const trace = JSON.parse(f.raw);
    trace.traceEvents.pop();
    await fs.writeFile(f.rawPath, JSON.stringify(trace));
    await assert.rejects(f.run(), {
      message: "Profile review failed; raw trace remains private",
    });
    assert.equal(f.result.profile.reviewStage, "timeline-summary");
    assert.equal(
      f.result.profile.review.reasonCodes.join(),
      "timeline-contract-invalid",
    );
    assert.deepEqual(await fs.readdir(f.directory), []);
  } finally {
    await f.cleanup();
  }
});

async function completeFirstTraceFixture(f) {
  f.result.ok = false;
  Object.assign(f.result.profile, {
    schemaVersion: 3,
    diagnosticOnly: true,
    acceptance: false,
    traceSampleLimit: 1,
    traceStopped: true,
    durationMs: 50,
    firstSampleAttributionComplete: true,
  });
  const first = f.result.samples[0];
  Object.assign(first, {
    trusted: true,
    pendingDomMs: 105,
    messageId: "message-A",
    ipc: [
      {
        threadId: "thread-A",
        clientUserMessageId: "client-A",
        receipt: { turnId: "turn-A" },
      },
    ],
    canonicalEventVerification: {
      itemId: "message-A",
      clientId: "client-A",
      turnId: "turn-A",
    },
    notifications: [
      {
        threadId: "thread-A",
        turnId: "turn-A",
        itemType: "user_message",
        itemId: "message-A",
        clientId: "client-A",
      },
      { threadId: "thread-A", turnId: "turn-A", type: "turn_completed" },
    ],
  });
  for (const key of [
    "firstVisibleFeedbackMs",
    "clickToPendingDomMs",
    "clickToPendingVisibleFrameMs",
    "clickToBubbleDomMs",
    "clickToVisibleFrameMs",
    "clickToClearFrameMs",
    "clickToCanonicalNotificationMs",
    "clickToFeedbackGeometryCompleteMs",
    "clickToFeedbackSubsequentFrameMs",
    "clickToClearGeometryCompleteMs",
    "clickToClearSubsequentFrameMs",
    "feedbackTargetMs",
  ])
    first[key] = 1;
  f.result.samples = [first];
  const trace = JSON.parse(f.raw);
  trace.traceEvents = trace.traceEvents.filter(
    (event) => event.ph === "M" || event.name.startsWith("zen-send-0-"),
  );
  trace.traceEvents.push({
    ph: "I",
    pid: 2,
    tid: 22,
    name: "zen-send-0-first-pending-dom-observed",
    ts: 105000,
  });
  await fs.writeFile(f.rawPath, JSON.stringify(trace));
  await fs.mkdir(path.join(f.temporary, "out/renderer"), { recursive: true });
  await fs.writeFile(
    path.join(f.temporary, "out/renderer/index-synthetic.js"),
    "// synthetic owned fixture only",
  );
}

test("failed case projects one explicitly complete reviewed first trace without converting the case to success", async () => {
  const f = await fixture();
  try {
    await completeFirstTraceFixture(f);
    assert.equal(f.canReviewFirst(), true);
    const raw = await fs.readFile(f.rawPath, "utf8");
    await f.run({ failedCase: true });
    assert.equal(f.result.ok, false);
    assert.equal(f.result.profile.review.passed, true);
    const summary = JSON.parse(
      await fs.readFile(
        path.join(f.directory, "owned-native-send-profile.summary.json"),
        "utf8",
      ),
    );
    assert.equal(summary.captureOutcome, "case-failed");
    assert.equal(summary.attributionScope, "completed-first-sample-only");
    assert.equal(summary.fullCasePassed, false);
    assert.equal(summary.tracedSampleCount, 1);
    assert.equal(summary.samples.length, 1);
    assert.equal(summary.acceptance, false);
    assert.equal(summary.traceEvents, undefined);
    assert.equal(JSON.stringify(summary).includes(f.token), false);
    assert.equal(await fs.readFile(f.rawPath, "utf8"), raw);
    assert.deepEqual(await fs.readdir(f.directory), [
      "owned-native-send-profile.summary.json",
    ]);
  } finally {
    await f.cleanup();
  }
});

test("failed-case first-trace gate rejects timings alone, incomplete identities, missing terminal and unconfirmed stop or cap", async () => {
  const changes = [
    (f) => delete f.result.profile.firstSampleAttributionComplete,
    (f) => (f.result.profile.firstSampleAttributionComplete = false),
    (f) => (f.result.samples = []),
    (f) => (f.result.samples[0].trusted = false),
    (f) => delete f.result.samples[0].canonicalEventVerification,
    (f) => (f.result.samples[0].canonicalEventVerification.clientId = "wrong"),
    (f) => (f.result.samples[0].canonicalEventVerification.turnId = "wrong"),
    (f) => (f.result.samples[0].notifications[0].threadId = "wrong"),
    (f) => (f.result.samples[0].notifications[0].turnId = "wrong"),
    (f) => f.result.samples[0].notifications.pop(),
    (f) => f.result.samples[0].ipc.push(f.result.samples[0].ipc[0]),
    (f) => (f.result.profile.traceStopped = false),
    (f) => (f.result.profile.deadlineExceeded = true),
    (f) => (f.result.profile.durationMs = 120001),
  ];
  for (const mutate of changes) {
    const f = await fixture();
    try {
      await completeFirstTraceFixture(f);
      mutate(f);
      assert.equal(f.canReviewFirst(), false);
      await assert.rejects(f.run({ failedCase: true }), {
        message: "Profile review failed; raw trace remains private",
      });
      assert.equal(f.result.ok, false);
      assert.deepEqual(await fs.readdir(f.directory), []);
    } finally {
      await f.cleanup();
    }
  }
});

test("failed-case first trace retains every original privacy, loss, buffer and marker rejection", async () => {
  for (const failure of [
    "known-secret",
    "private-config",
    "missing-token",
    "full-buffer",
    "metadata-loss",
    "event-loss",
    "missing-marker",
  ]) {
    const f = await fixture();
    try {
      await completeFirstTraceFixture(f);
      if (failure === "known-secret")
        await fs.writeFile(f.rawPath, JSON.stringify({ leak: f.token }));
      else if (failure === "private-config")
        await fs.writeFile(f.rawPath, JSON.stringify({ leak: f.config }));
      else if (failure === "missing-token") await fs.rm(f.tokenPath);
      else if (failure === "full-buffer")
        f.result.profile.bufferUsage.percentage = 1;
      else {
        const trace = JSON.parse(await fs.readFile(f.rawPath, "utf8"));
        if (failure === "metadata-loss") trace.metadata = { dropped_events: 1 };
        if (failure === "event-loss")
          trace.traceEvents.push({
            ph: "I",
            pid: 2,
            tid: 22,
            name: "DataLoss",
            ts: 105000,
          });
        if (failure === "missing-marker") trace.traceEvents.pop();
        await fs.writeFile(f.rawPath, JSON.stringify(trace));
      }
      await assert.rejects(f.run({ failedCase: true }), {
        message: "Profile review failed; raw trace remains private",
      });
      assert.equal(f.result.ok, false);
      assert.equal(f.result.profile.review.passed, false);
      assert.deepEqual(await fs.readdir(f.directory), []);
      assert.equal(JSON.stringify(f.result).includes(f.token), false);
    } finally {
      await f.cleanup();
    }
  }
});

test("launcher failed-case export rechecks reviewed single-sample scope and secret guard, otherwise withholds", async () => {
  const source = await fs.readFile(
    path.join(__dirname, "launch-send-focus-paired.mjs"),
    "utf8",
  );
  const code = source.slice(
    source.indexOf("async function readReviewedFailedFirstTrace("),
    source.indexOf("function projectFailureNativeContinuity("),
  );
  const read = new Function(
    "assert",
    "readFile",
    "path",
    "return (" + code + ")",
  )(assert, fs.readFile, path);
  const f = await fixture();
  try {
    await completeFirstTraceFixture(f);
    await f.run({ failedCase: true });
    f.result.profile.failedCaseFirstSampleProjected = true;
    let scans = 0;
    const args = {
      capture: f.result,
      close: { code: 1, signal: null },
      directory: f.directory,
      privateConfig: f.config,
      guard: {
        scan(serialized, config) {
          scans++;
          assert.equal(config, f.config);
          assert.equal(serialized.includes(f.token), false);
        },
      },
    };
    const reviewed = await read(args);
    assert.equal(reviewed.status, "reviewed");
    assert.equal(reviewed.caseFailed, true);
    assert.equal(reviewed.scope, "completed-first-sample-only");
    assert.equal(scans, 1);
    for (const override of [
      { guard: undefined },
      {
        guard: {
          scan() {
            throw Error("known secret rejected");
          },
        },
      },
      { close: { code: null, signal: "SIGTERM" } },
      {
        capture: {
          ...f.result,
          profile: {
            ...f.result.profile,
            firstSampleAttributionComplete: false,
          },
        },
      },
      {
        capture: {
          ...f.result,
          profile: { ...f.result.profile, review: { passed: false } },
        },
      },
      {
        capture: {
          ...f.result,
          profile: {
            ...f.result.profile,
            failedCaseFirstSampleProjected: false,
          },
        },
      },
    ]) {
      assert.equal((await read({ ...args, ...override })).status, "withheld");
    }
    const filename = path.join(
      f.directory,
      "owned-native-send-profile.summary.json",
    );
    const valid = JSON.parse(await fs.readFile(filename, "utf8"));
    for (const change of [
      (summary) => (summary.tracedSampleCount = 3),
      (summary) => (summary.review.passed = false),
      (summary) => (summary.captureOutcome = "passed"),
      (summary) => (summary.fullCasePassed = true),
    ]) {
      const invalid = structuredClone(valid);
      change(invalid);
      await fs.writeFile(filename, JSON.stringify(invalid));
      assert.equal((await read(args)).status, "withheld");
    }
    const capturedSuccess = structuredClone(valid);
    for (const key of [
      "captureOutcome",
      "attributionScope",
      "fullCasePassed",
      "storageVerification",
    ])
      delete capturedSuccess[key];
    await fs.writeFile(filename, JSON.stringify(capturedSuccess));
    const postcheckFailure = await read({
      ...args,
      capture: { ...f.result, ok: true },
      close: { code: 0, signal: null },
    });
    assert.equal(postcheckFailure.status, "reviewed");
    assert.equal(
      postcheckFailure.caseFailed,
      true,
      "A later launcher rejection never becomes a passing case",
    );
    await fs.rm(filename);
    assert.equal((await read(args)).status, "withheld");
  } finally {
    await f.cleanup();
  }
});
