import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { OpenCodeAgentProviderAdapter } from "../src/main/agent-providers/opencode-adapter.js";
import type { AgentProviderEvent } from "../src/main/agent-providers/types.js";

const SERVER = await readFile(
  new URL("./fixtures/opencode-app-server.mjs", import.meta.url),
  "utf8",
);

async function fixture(behavior = "normal", home?: string) {
  const directory =
    home ?? (await mkdtemp(path.join(os.tmpdir(), "opencode-adapter-")));
  const script = path.join(directory, "server.mjs");
  const source =
    behavior === "scoped-models"
      ? SERVER.replace(
          'if (p === "/provider")',
          `if (p === "/provider" && !url.searchParams.get("directory")) return json({all:[],connected:[],default:{}}); if (p === "/provider")`,
        )
      : behavior === "stale-permission"
        ? SERVER.replace(
            'if (p === "/permission") return json(state.permissions);',
            'if (p === "/permission") { setTimeout(() => json(state.permissions), 180); return; }',
          )
        : SERVER;
  await writeFile(script, source);
  const children: ReturnType<typeof spawn>[] = [];
  const spawnProcess = ((command: string, args: string[], options: object) => {
    assert.equal(command, "opencode");
    assert.deepEqual(args, ["serve", "--hostname", "127.0.0.1", "--port", "0"]);
    const child = spawn(
      process.execPath,
      [script, directory, behavior, ...args],
      options,
    );
    children.push(child);
    return child;
  }) as typeof spawn;
  const adapter = new OpenCodeAgentProviderAdapter({
    spawnProcess,
    processCwd: directory,
    startupTimeoutMs: 5000,
    requestTimeoutMs: 1500,
  });
  const events: AgentProviderEvent[] = [];
  adapter.onEvent((event) => events.push(event));
  return {
    adapter,
    directory,
    children,
    events,
    requests: async () =>
      (await readFile(path.join(directory, "requests.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              method: string;
              path: string;
              directory: string | null;
              body: Record<string, unknown>;
            },
        ),
  };
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error("Expected native event did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("project-scoped OpenCode model is usable for creation", async () => {
  const f = await fixture("scoped-models");
  try {
    await f.adapter.create({
      cwd: f.directory,
      permissionMode: "danger-full-access",
      model: "test/model-one",
    });
  } finally {
    console.log("SCOPED_CATALOG_REQUESTS", await f.requests());
    await f.adapter.dispose();
  }
});
test("stale native permission read must not revive replied approval", async () => {
  const f = await fixture("stale-permission");
  try {
    const native = await f.adapter.create({
      cwd: f.directory,
      permissionMode: "danger-full-access",
    });
    await f.adapter.send(native.nativeSessionId, {
      text: "test approval race",
    });
    await until(() => f.events.some((e) => e.type === "approval"));
    const a = f.events.find((e) => e.type === "approval")!;
    if (a.type !== "approval") throw Error("fixture");
    const oldRead = f.adapter.read(native.nativeSessionId);
    await new Promise((r) => setTimeout(r, 70));
    await f.adapter.respondApproval(a.requestId, "accept");
    await oldRead;
    const approvals = f.events.filter(
      (e) => e.type === "approval" || e.type === "approvalResolved",
    );
    console.log(
      "APPROVAL_RACE",
      approvals.map((e) => ({ type: e.type, requestId: e.requestId })),
    );
    assert.equal(approvals.at(-1)?.type, "approvalResolved");
  } finally {
    await f.adapter.dispose();
  }
});
