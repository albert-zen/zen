import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createHostedAppServer,
  type HostedZenAppServer,
  type ZenHostOptions,
  type HostProviderProfile,
} from "../apps/cli/src/host.js";
import { FileTraceStore } from "../src/trace.js";
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};
function profile(
  id: string,
  endpoint: string,
  key: string,
): HostProviderProfile {
  return {
    providerProfileId: id,
    provider: {
      type: "openai-compatible",
      baseUrl: `https://${endpoint}.invalid/v1`,
      apiKey: key,
    },
    model: "synthetic",
    modelCatalog: [
      {
        id: "synthetic",
        isDefault: true,
        contextWindow: 32768,
        inputModalities: ["text"],
        defaultReasoningEffort: "medium",
      },
    ],
  };
}
const success = (text: string) =>
  new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
  );
async function publish(
  host: HostedZenAppServer,
  options: ZenHostOptions,
  revision: number,
) {
  host.publishConfiguration(await host.prepareConfiguration(options, revision));
}
for (const mode of ["edit", "delete-readd", "delete-after-dispatch"] as const)
  test(`actual Host ${mode} preserves frozen resource and live membership separately`, async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zen-frozen-provider-"),
    );
    const originalFetch = globalThis.fetch;
    const entered = deferred(),
      release = deferred();
    const requests: Array<{
      url: string;
      authorization: string | null;
      body: string;
    }> = [];
    const first = profile("primary", "old-endpoint", "synthetic-old-key"),
      spare = profile("spare", "spare-endpoint", "synthetic-spare-key");
    const base: ZenHostOptions = {
      cwd: directory,
      dataDirectory: directory,
      providers: [first, spare],
      defaultSelection: { providerProfileId: "primary", modelId: "synthetic" },
      approvalPolicy: "never",
      toolPresentation: "direct",
    };
    globalThis.fetch = async (url, init) => {
      requests.push({
        url: String(url),
        authorization: new Headers(init?.headers).get("authorization"),
        body: String(init?.body),
      });
      if (requests.length === 1) {
        entered.resolve();
        await release.promise;
        if (mode !== "delete-after-dispatch")
          return new Response("synthetic retry body", { status: 503 });
      }
      return success(
        mode === "delete-after-dispatch"
          ? "already-dispatched outcome"
          : "complete",
      );
    };
    const host = createHostedAppServer(base);
    t.after(async () => {
      release.resolve();
      await host.closeHostResources();
      globalThis.fetch = originalFetch;
      await rm(directory, { recursive: true, force: true });
    });
    const thread = await host.startThread();
    const firstTurn = await host.startTurn(thread.id, "first");
    await entered.promise;
    if (mode === "edit")
      await publish(
        host,
        {
          ...base,
          providers: [
            profile("primary", "new-endpoint", "synthetic-new-key"),
            spare,
          ],
        },
        1,
      );
    else {
      await publish(
        host,
        {
          ...base,
          providers: [spare],
          defaultSelection: {
            providerProfileId: "spare",
            modelId: "synthetic",
          },
        },
        1,
      );
      if (mode === "delete-readd") await publish(host, base, 2);
    }
    release.resolve();
    await firstTurn.done;
    const trace = new FileTraceStore(path.join(directory, "trace"));
    let records = (await trace.read(thread.id)).records;
    if (mode === "edit") {
      assert.equal(requests.length, 2);
      assert.equal(
        requests[0]!.url,
        "https://old-endpoint.invalid/v1/chat/completions",
      );
      assert.equal(requests[1]!.url, requests[0]!.url);
      assert.equal(requests[1]!.authorization, "Bearer synthetic-old-key");
      assert.equal(requests[1]!.body, requests[0]!.body);
      await (
        await host.startTurn(thread.id, "second")
      ).done;
      assert.equal(requests.length, 3);
      assert.equal(
        requests[2]!.url,
        "https://new-endpoint.invalid/v1/chat/completions",
      );
      assert.equal(requests[2]!.authorization, "Bearer synthetic-new-key");
      records = (await trace.read(thread.id)).records;
      assert.equal(
        records.filter((record) => record.type === "model_request_dispatched")
          .length,
        3,
      );
    } else if (mode === "delete-readd") {
      assert.equal(
        requests.length,
        1,
        "delete/readd cannot revive the old membership lease",
      );
      assert(
        records.some((record) => record.type === "model_dispatch_blocked"),
      );
      assert.equal(
        (await host.readThread(thread.id)).turns.at(-1)?.status,
        "failed",
      );
      await (
        await host.startTurn(thread.id, "new membership")
      ).done;
      assert.equal(
        requests.length,
        2,
        "a new sample may use the explicitly re-added membership",
      );
    } else {
      assert.equal(requests.length, 1);
      assert.equal(
        (await host.readThread(thread.id)).turns.at(-1)?.status,
        "completed",
      );
      assert(
        records.some(
          (record) =>
            record.type === "model_sample_finished" &&
            (record.data as { outcome: string }).outcome === "completed",
        ),
      );
      assert(
        !records.some((record) => record.type === "model_dispatch_blocked"),
      );
    }
    assert.equal(JSON.stringify(records).includes("synthetic-old-key"), false);
    assert.equal(JSON.stringify(records).includes("synthetic-new-key"), false);
    const observed = records.filter(
      (record) => record.type === "model_request_dispatched",
    );
    assert(observed.length >= 1);
  });
