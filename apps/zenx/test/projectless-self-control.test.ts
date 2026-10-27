import assert from "node:assert/strict";
import test from "node:test";
import { ZenXProjectProjection } from "../src/main/project-projection.js";
import {
  ZenXSelfControlCapabilityPackage,
  type AppServerRequestPort,
} from "../src/main/capabilities/self-control-package.js";

function fixture(options: { fail?: boolean; abort?: AbortController } = {}) {
  const requests: Array<{ method: string; params: unknown }> = [];
  const allocations: Array<string | undefined> = [];
  const projection = new ZenXProjectProjection();
  const appServer = {
    projectProjection: projection,
    async request(method: string, params: { cwd: string }) {
      requests.push({ method, params });
      return {
        thread: {
          id: "owned-thread",
          cwd: params.cwd,
          preview: "",
          name: null,
          status: { type: "idle" },
          createdAt: 0,
          updatedAt: 0,
        },
        cwd: params.cwd,
        model: "fixture-model",
        modelProvider: "fixture",
        reasoningEffort: "medium",
        approvalPolicy: "never",
        sandbox: { type: "dangerFullAccess" },
      };
    },
  } as AppServerRequestPort;
  const pkg = new ZenXSelfControlCapabilityPackage({
    appServer,
    createProjectlessWorkspace: async (name) => {
      allocations.push(name);
      if (options.fail) throw new Error("profile write failed");
      options.abort?.abort();
      return "/synthetic/Documents/ZenX/date/report";
    },
  });
  const invoke = (args: Record<string, unknown>) =>
    pkg.invoke("zenx_threads_create", {
      name: "zenx_threads_create",
      callId: "fixture",
      cwd: "/caller",
      arguments: args,
      signal: options.abort?.signal ?? new AbortController().signal,
    });
  return { invoke, requests, allocations };
}

test("projectless self-control allocates on this Host then creates an ordinary idle native Thread", async () => {
  const f = fixture();
  const result = (await f.invoke({
    projectless: true,
    directoryName: "中文报告",
    model: "fixture-model",
    effort: "medium",
  })) as { threadId: string; runtime: { cwd: string } };
  assert.deepEqual(f.allocations, ["中文报告"]);
  assert.equal(result.threadId, "owned-thread");
  assert.equal(result.runtime.cwd, "/synthetic/Documents/ZenX/date/report");
  assert.deepEqual(f.requests, [
    {
      method: "thread/start",
      params: {
        cwd: result.runtime.cwd,
        model: "fixture-model",
        effort: "medium",
      },
    },
  ]);
});

test("projectless profile failure or cancellation does not dispatch native creation", async () => {
  for (const options of [{ fail: true }, { abort: new AbortController() }]) {
    const f = fixture(options);
    await assert.rejects(f.invoke({ projectless: true }));
    assert.equal(f.allocations.length, 1);
    assert.deepEqual(f.requests, []);
  }
});

test("explicit projectless does not broaden configured cwd authorization or silently replace invalid targets", async () => {
  for (const args of [
    { cwd: "/not-configured" },
    {},
    { projectless: false },
    { projectless: true, cwd: "/not-configured" },
    { projectless: true, project: "any" },
    { directoryName: "report", cwd: "/not-configured" },
    { projectless: true, effort: 42 },
  ]) {
    const f = fixture();
    await assert.rejects(f.invoke(args));
    assert.deepEqual(f.allocations, []);
    assert.deepEqual(f.requests, []);
  }
});
