import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  OperationalDiagnosticLog,
  normalizeOperationalDiagnostic,
} from "../src/main/operational-diagnostic-log.js";
import { JsonZenXPluginCatalogStore } from "../src/main/capabilities/plugin-catalog-store.js";
import { ZenXPluginCatalog } from "../src/main/capabilities/plugin-catalog.js";

async function temporaryDirectory(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "zenx-operations-diagnostic-"));
}

async function records(root: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(
    path.join(root, "diagnostics", "operations.jsonl"),
    "utf8",
  );
  return raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("operational diagnostics retain fixed codes and discard arbitrary messages", async () => {
  const root = await temporaryDirectory();
  try {
    const log = new OperationalDiagnosticLog(root);
    await log.observeAppServer({
      type: "error",
      message: "secret stderr /Users/private/file token=abc",
    });
    await log.observeComputer({
      platform: "darwin",
      accessibility: "needs-setup",
      screenRecording: "denied",
      foregroundControlEnabled: false,
      verification: {
        accessibility: { state: "failed", detail: "private window title" },
        screenCapture: { state: "needs-setup" },
      },
    });
    await log.observePlugins({
      discoveryErrors: ["plugin secret failed at /Users/private/file"],
      bundledStartupFailureCount: 0,
      providerDiagnostics: [
        {
          capabilityId: "browser",
          providerId: "private-provider-id",
          status: "unavailable",
          interactionModes: [],
          capabilities: [],
          executable: "/Users/private/bin",
          reason: "private endpoint token=abc",
        },
      ],
    });
    const result = await records(root);
    assert.deepEqual(
      result.map((entry) => [entry.event, entry.status ?? entry.reason]),
      [
        ["app-server", "error"],
        ["computer-readiness", "denied"],
        ["plugin", "discovery-error"],
        ["plugin", "provider-unavailable"],
      ],
    );
    assert.ok(result.every((entry) => typeof entry.timestamp === "string"));
    const raw = JSON.stringify(result);
    for (const secret of [
      "secret stderr",
      "/Users/private",
      "token=abc",
      "private window title",
      "private-provider-id",
    ]) {
      assert.equal(raw.includes(secret), false);
    }
    if (process.platform !== "win32") {
      assert.equal(
        (await stat(path.join(root, "diagnostics"))).mode & 0o777,
        0o700,
      );
      assert.equal(
        (await stat(path.join(root, "diagnostics", "operations.jsonl"))).mode &
          0o777,
        0o600,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("operational diagnostics report state transitions once and retain later failures", async () => {
  const root = await temporaryDirectory();
  try {
    const log = new OperationalDiagnosticLog(root);
    await log.observeAppServer({ type: "starting" });
    await log.observeAppServer({ type: "starting" });
    await log.observeAppServer({ type: "ready", reconnected: false });
    await log.observeAppServer({ type: "ready", reconnected: true });
    const computer = {
      platform: "darwin" as const,
      accessibility: "unknown" as const,
      screenRecording: "not-determined" as const,
      foregroundControlEnabled: false,
    };
    await log.observeComputer(computer);
    await log.observeComputer(computer);
    await log.observeComputer({
      ...computer,
      screenRecording: "granted",
      verification: {
        accessibility: { state: "ready" },
        screenCapture: { state: "ready" },
      },
    });
    const failed = {
      capabilityId: "computer",
      providerId: "hidden-id",
      status: "unavailable" as const,
      interactionModes: [] as [],
      capabilities: [] as [],
      reason: "private error",
    };
    await log.observePlugins({
      discoveryErrors: ["first secret"],
      bundledStartupFailureCount: 0,
      providerDiagnostics: [failed],
    });
    await log.observePlugins({
      discoveryErrors: ["first secret"],
      bundledStartupFailureCount: 0,
      providerDiagnostics: [failed],
    });
    await log.observePlugins({
      discoveryErrors: ["first secret"],
      bundledStartupFailureCount: 0,
      providerDiagnostics: [{ ...failed, status: "selected" }],
    });
    await log.observePlugins({
      discoveryErrors: ["first secret", "second secret"],
      bundledStartupFailureCount: 0,
      providerDiagnostics: [failed],
    });
    const result = await records(root);
    assert.deepEqual(
      result.map((entry) => [entry.event, entry.status ?? entry.reason]),
      [
        ["app-server", "starting"],
        ["app-server", "ready"],
        ["app-server", "reconnected"],
        ["computer-readiness", "not-determined"],
        ["computer-readiness", "granted"],
        ["plugin", "discovery-error"],
        ["plugin", "provider-unavailable"],
        ["plugin", "discovery-error"],
        ["plugin", "provider-unavailable"],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("operational log has a fixed rotation budget and ignores filesystem failures", async () => {
  const root = await temporaryDirectory();
  try {
    const log = new OperationalDiagnosticLog(root, { maxBytes: 600 });
    for (let index = 0; index < 40; index++) {
      await log.observeAppServer({
        type: index % 2 === 0 ? "starting" : "stopped",
      });
    }
    const file = path.join(root, "diagnostics", "operations.jsonl");
    assert.ok((await stat(file)).size <= 600);
    assert.ok((await stat(`${file}.1`)).size <= 600);
    const blocked = path.join(root, "blocked");
    await writeFile(blocked, "not a directory");
    const unusable = new OperationalDiagnosticLog(blocked);
    await assert.doesNotReject(
      unusable.observeAppServer({ type: "error", message: "private" }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed write can be retried with the same observed state after storage recovers", async () => {
  const root = await temporaryDirectory();
  try {
    const userData = path.join(root, "blocked");
    await writeFile(userData, "not a directory");
    const log = new OperationalDiagnosticLog(userData);
    const appServer = { type: "error" as const, message: "private" };
    const computer = {
      platform: "darwin" as const,
      accessibility: "needs-setup" as const,
      screenRecording: "denied" as const,
      foregroundControlEnabled: false,
    };
    const plugins = {
      discoveryErrors: ["private error", "private install error"],
      bundledStartupFailureCount: 1,
      providerDiagnostics: [
        {
          capabilityId: "browser",
          providerId: "private-provider",
          status: "unavailable" as const,
          interactionModes: [] as [],
          capabilities: [] as [],
        },
      ],
    };
    await log.observeAppServer(appServer);
    await log.observeComputer(computer);
    await log.observePlugins(plugins);
    await rm(userData);
    await mkdir(userData);
    await log.observeAppServer(appServer);
    await log.observeComputer(computer);
    await log.observePlugins(plugins);
    assert.deepEqual(
      (await records(userData)).map((entry) => [
        entry.event,
        entry.status ?? entry.reason,
      ]),
      [
        ["app-server", "error"],
        ["computer-readiness", "denied"],
        ["plugin", "discovery-error"],
        ["plugin", "plugin-startup-failed"],
        ["plugin", "provider-unavailable"],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent reports of one state write a single diagnostic record", async () => {
  const root = await temporaryDirectory();
  try {
    const log = new OperationalDiagnosticLog(root);
    await Promise.all(
      Array.from({ length: 6 }, () =>
        log.observeAppServer({ type: "error", message: "private" }),
      ),
    );
    assert.equal((await records(root)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plugin startup failure uses a lifecycle code instead of claiming discovery failed", async () => {
  const root = await temporaryDirectory();
  try {
    const log = new OperationalDiagnosticLog(root);
    await log.recordPluginStartupFailure();
    assert.deepEqual(
      (await records(root)).map((entry) => [entry.event, entry.reason]),
      [["plugin", "plugin-startup-failed"]],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bootstrap failures before App Server creation keep their own fixed code", async () => {
  const root = await temporaryDirectory();
  try {
    const log = new OperationalDiagnosticLog(root);
    await log.recordBootstrapFailure();
    assert.deepEqual(
      (await records(root)).map((entry) => [entry.event, entry.status]),
      [["desktop-bootstrap", "failed"]],
    );
    const projected = normalizeOperationalDiagnostic({
      event: "desktop-bootstrap",
      status: "failed",
      message: "private profile path /Users/private/config.json",
    });
    assert.deepEqual(Object.keys(projected ?? {}).sort(), [
      "event",
      "status",
      "timestamp",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundled installation failures retain UI detail but log a startup code", async () => {
  const root = await temporaryDirectory();
  try {
    const catalog = new ZenXPluginCatalog(
      new JsonZenXPluginCatalogStore(path.join(root, "catalog.json")),
    );
    await catalog.initialize();
    catalog.recordDiscoveryError("private discovery path");
    catalog.recordBundledStartupError("private install error");
    const diagnostics = catalog.diagnostics();
    assert.deepEqual(diagnostics.discoveryErrors, [
      "private discovery path",
      "private install error",
    ]);
    assert.equal(diagnostics.bundledStartupFailureCount, 1);
    const log = new OperationalDiagnosticLog(root);
    await log.observePlugins(diagnostics);
    await log.observePlugins(diagnostics);
    assert.deepEqual(
      (await records(root)).map((entry) => entry.reason),
      ["discovery-error", "plugin-startup-failed"],
    );
    catalog.recordBundledStartupError("second private install error");
    await log.observePlugins(catalog.diagnostics());
    assert.deepEqual(
      (await records(root)).map((entry) => entry.reason),
      ["discovery-error", "plugin-startup-failed", "plugin-startup-failed"],
    );
    assert.equal(
      JSON.stringify(await records(root)).includes("private"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("operational normalizer rejects arbitrary codes rather than persisting input", () => {
  assert.equal(
    normalizeOperationalDiagnostic({
      event: "app-server",
      status: "error: private stderr",
    }),
    null,
  );
  assert.equal(
    normalizeOperationalDiagnostic({
      event: "plugin",
      reason: "token=abc",
      capability: "browser",
    }),
    null,
  );
});
