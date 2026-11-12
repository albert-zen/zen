import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ModelRequestDebugStore } from "../../cli/src/model-request-debug.js";
import { FileAttachmentStore } from "../../../src/attachment.js";
import { compileItemList } from "../../../src/item-list.js";
import { FileItemListStore } from "../../../src/item-list-store.js";
import { FileTraceStore, type TraceRecord } from "../../../src/trace.js";
import { ZenXCredentialVault } from "../src/main/credential-vault.js";
import {
  ZenXHostProfileStore,
  structuredLegacyModelCatalog,
  type ZenXHostProfile,
} from "../src/main/host-profile.js";
import { ZenXSettingsService } from "../src/main/settings-service.js";
import { ZenXConfiguredTitleInference } from "../src/main/title-inference.js";

const chatResponse = (text = "Synthetic title") =>
  new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
const responsesResponse = () =>
  new Response(
    'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_fixture","role":"assistant","content":[]}}\n\ndata: {"type":"response.output_text.delta","output_index":0,"delta":"Synthetic title"}\n\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\ndata: [DONE]\n\n',
    { headers: { "content-type": "text/event-stream" } },
  );

async function fixture(
  t: test.TestContext,
  fetch: typeof globalThis.fetch,
  protocol: "chat-completions" | "responses" = "chat-completions",
  subscription?: ConstructorParameters<
    typeof ZenXSettingsService
  >[0]["subscription"],
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-aux-context-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataDirectory = path.join(directory, "data");
  const profilePath = path.join(directory, "host-profile.json");
  const store = new ZenXHostProfileStore(profilePath);
  const profile: ZenXHostProfile = {
    version: 3,
    onboardingComplete: true,
    providerProfiles: [
      {
        providerProfileId: "synthetic",
        type: "openai-compatible",
        name: "synthetic",
        displayName: "Synthetic",
        baseUrl: "https://old.synthetic.test/v1",
        protocol,
        models: structuredLegacyModelCatalog("openai-compatible", [
          "model-old",
          "model-new",
        ]).map((entry) => ({ ...entry, contextWindow: 32_768 })),
      },
      {
        providerProfileId: "local",
        type: "fake",
        displayName: "Local",
        models: structuredLegacyModelCatalog("fake", ["fake"]),
      },
    ],
    defaultModel: { providerProfileId: "synthetic", modelId: "model-old" },
    titleModel: { providerProfileId: "synthetic", modelId: "model-old" },
    titlePrompt: "Title request: {{request}}",
    workspace: directory,
    workspaces: [directory],
    lastUsedWorkspace: directory,
    pinnedThreadIds: ["existing-user-thread"],
    visibleSubagentThreadIds: [],
    sidebarOrder: { projectKeys: [], threadIdsByProject: {} },
    approvalPolicy: "never",
  };
  if (subscription) {
    profile.providerProfiles[0] = {
      providerProfileId: "synthetic",
      type: "openai-subscription",
      displayName: "Synthetic subscription",
      models: structuredLegacyModelCatalog("openai-subscription", [
        "model-old",
        "model-new",
      ]).map((entry) => ({
        ...entry,
        contextWindow: 32768,
        defaultReasoningEffort: "medium",
      })),
    };
  }
  await store.write(profile);
  const vault = new ZenXCredentialVault(path.join(directory, "vault"), {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s),
    decryptString: (b) => b.toString(),
  });
  await vault.writeApiKey("synthetic", "old-synthetic-key");
  const settings = new ZenXSettingsService({
    userDataDirectory: directory,
    zenDataDirectory: dataDirectory,
    vault,
    profileStore: store,
    providerFetchFactory: () => fetch,
    ...(subscription === undefined
      ? {}
      : { subscriptionFactory: () => subscription }),
    subscription: subscription ?? {
      login: async () => undefined,
      logout: async () => undefined,
      status: async () => ({ authenticated: false, expired: false }),
    },
  });
  await settings.initialize({});
  return {
    directory,
    dataDirectory,
    profilePath,
    settings,
    inference: new ZenXConfiguredTitleInference(settings),
    coldTrace: () => new FileTraceStore(path.join(dataDirectory, "trace")),
  };
}

function sourceItems(records: TraceRecord[]) {
  return records
    .filter((r) => r.type === "context_source")
    .map((r) => (r.data as { item: unknown }).item);
}

test("configured title and probe actual transports cold-reopen in the all-local reader with matching durable semantic bundles", async (t) => {
  for (const protocol of ["chat-completions", "responses"] as const) {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const f = await fixture(
      t,
      async (url, init) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
        });
        return protocol === "responses" ? responsesResponse() : chatResponse();
      },
      protocol,
    );
    const before = await readFile(f.profilePath, "utf8");
    assert.equal(
      await f.inference.generate(
        "Untrusted user excerpt",
        "model-old",
        new AbortController().signal,
      ),
      "Synthetic title",
    );
    assert.equal(
      await readFile(f.profilePath, "utf8"),
      before,
      "Title inference cannot edit product state",
    );
    const probe = await f.settings.probeProviderModelImage(
      "synthetic",
      "model-old",
    );
    assert.equal(probe.outcome, "supported");
    const after = (await f.settings.publicSettings()).profile;
    assert.deepEqual(after.pinnedThreadIds, ["existing-user-thread"]);
    assert.equal(f.settings.activeConfigurationOperations(), 0);
    const trace = f.coldTrace();
    const reader = new ModelRequestDebugStore(trace);
    const listed = await reader.control({ action: "list", threadId: "" });
    assert.equal(listed.records?.length, 2);
    assert.deepEqual(listed.records?.map((r) => r.purpose).sort(), [
      "image-probe",
      "title",
    ]);
    for (const summary of listed.records!) {
      assert.match(summary.threadId, /^auxiliary-[\w-]+$/u);
      assert.equal(summary.dispatch, "observed");
      assert.equal(summary.preparedRequestCaptured, true);
      const records = (await trace.read(summary.threadId)).records;
      const bundle = await new FileItemListStore(
        path.join(f.dataDirectory, "context-bundles"),
      ).read(summary.threadId);
      assert.deepEqual(sourceItems(records), bundle);
      const compiled = compileItemList(bundle);
      const started = records.find((r) => r.type === "model_sample_started")!;
      assert.deepEqual(
        (started.data as { selectedItemIds: string[] }).selectedItemIds,
        compiled.selectedItemIds,
      );
      const payload = (
        await reader.control({
          action: "read",
          threadId: summary.threadId,
          id: summary.id,
          view: "payload",
        })
      ).page!;
      assert.equal(payload.availability, "available");
      const body = JSON.parse(payload.text);
      const input = (
        protocol === "responses" ? body.input : body.messages
      ).filter((message: { role: string }) => message.role === "user");
      const expectedUser = compiled.messages.find((m) => m.role === "user")!;
      assert.equal(expectedUser.role, "user");
      assert.ok("content" in expectedUser);
      assert.equal(input[0].role, "user");
      assert.equal(
        input[0].content[0].text,
        expectedUser.content[0]?.type === "text"
          ? expectedUser.content[0].text
          : "",
      );
      if (summary.purpose === "title") {
        assert.equal(
          body[protocol === "responses" ? "max_output_tokens" : "max_tokens"],
          4096,
        );
      } else {
        assert.equal(
          body[protocol === "responses" ? "max_output_tokens" : "max_tokens"],
          1,
        );
        const image = expectedUser.content.find(
          (part) => part.type === "image",
        )!;
        assert.ok(image.type === "image");
        const bytes = await new FileAttachmentStore(
          path.join(f.dataDirectory, "attachments"),
        ).read(image.attachment);
        assert.ok(bytes.length > 0);
        const actualImage =
          protocol === "responses"
            ? input[0].content[1].image_url
            : input[0].content[1].image_url.url;
        assert.equal(
          actualImage,
          `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
        );
      }
      assert.doesNotMatch(
        payload.text,
        /auxiliary-|existing-user-thread|old-synthetic-key/u,
      );
    }
    assert.equal(requests.length, 2);
    assert.ok(
      requests.every((r) =>
        r.url.endsWith(
          protocol === "responses" ? "/responses" : "/chat/completions",
        ),
      ),
    );
    assert.deepEqual((await readdir(f.dataDirectory)).sort(), [
      "attachments",
      "context-bundles",
      "trace",
    ]);
    assert.deepEqual(
      (
        await reader.control({
          action: "list",
          threadId: "existing-user-thread",
        })
      ).records,
      [],
    );
  }
});

test("selected title URL, key, model and prompt stay frozen while the next sample sees the update", async (t) => {
  const dispatched: Array<{
    url: string;
    key: string | null;
    body: Record<string, unknown>;
  }> = [];
  const f = await fixture(t, async (url, init) => {
    dispatched.push({
      url: String(url),
      key: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)),
    });
    return chatResponse();
  });
  const select = f.settings.titleModel.bind(f.settings);
  let update = true;
  f.settings.titleModel = async (signal) => {
    const selected = await select(signal);
    const record = selected.trace.record.bind(selected.trace);
    selected.trace.record = async (event) => {
      if (update && event.type === "context_source") {
        update = false;
        const profile = (await f.settings.publicSettings()).profile;
        const provider = profile.providerProfiles.find(
          (p) => p.providerProfileId === "synthetic",
        )!;
        assert.equal(provider.type, "openai-compatible");
        if (provider.type !== "openai-compatible")
          throw new Error("fixture provider");
        await f.settings.editProviderProfile(
          "synthetic",
          { ...provider, baseUrl: "https://new.synthetic.test/v1" },
          {
            apiKey: "new-synthetic-key",
            titleModel: {
              providerProfileId: "synthetic",
              modelId: "model-new",
            },
          },
        );
        const workflow = await f.settings.workflowConfiguration();
        await f.settings.saveWorkflowConfiguration({
          baseRevision: workflow.revision,
          commands: workflow.commands,
          titlePrompt: "New title: {{request}}",
        });
      }
      return record(event);
    };
    return selected;
  };
  await f.inference.generate(
    "Input",
    "model-old",
    new AbortController().signal,
  );
  await f.inference.generate(
    "Input",
    "model-new",
    new AbortController().signal,
  );
  assert.deepEqual(
    dispatched.map((r) => [r.url, r.key, r.body.model]),
    [
      [
        "https://old.synthetic.test/v1/chat/completions",
        "Bearer old-synthetic-key",
        "model-old",
      ],
      [
        "https://new.synthetic.test/v1/chat/completions",
        "Bearer new-synthetic-key",
        "model-new",
      ],
    ],
  );
  assert.match(JSON.stringify(dispatched[0]!.body), /Title request: Input/u);
  assert.match(JSON.stringify(dispatched[1]!.body), /New title: Input/u);
});

test("provider removal during awaited request capture is prepared and blocked, not dispatched", async (t) => {
  let fetches = 0;
  const f = await fixture(t, async () => {
    fetches++;
    return chatResponse();
  });
  const select = f.settings.titleModel.bind(f.settings);
  f.settings.titleModel = async (signal) => {
    const selected = await select(signal);
    const record = selected.trace.record.bind(selected.trace);
    selected.trace.record = async (event) => {
      const receipt = await record(event);
      if (event.type === "model_request")
        await f.settings.deleteProviderProfile("synthetic", {
          defaultModel: { providerProfileId: "local", modelId: "fake" },
          titleModel: { providerProfileId: "local", modelId: "fake" },
        });
      return receipt;
    };
    return selected;
  };
  await assert.rejects(
    f.inference.generate("Input", "model-old", new AbortController().signal),
    /dispatch blocked/u,
  );
  assert.equal(fetches, 0);
  const record = (
    await new ModelRequestDebugStore(f.coldTrace()).control({
      action: "list",
      threadId: "",
    })
  ).records![0]!;
  assert.equal(record.purpose, "title");
  assert.equal(record.preparedRequestCaptured, true);
  assert.equal(record.dispatch, "blocked");
  assert.equal(record.sampleOutcome, "failed");
});

test("actual auxiliary empty responses, HTTP failures and cancellation retain truthful terminal Trace", async (t) => {
  for (const mode of ["empty", "error", "cancel"] as const) {
    const controller = new AbortController();
    const f = await fixture(t, async () => {
      if (mode === "error")
        return new Response('{"error":{"message":"Synthetic denial"}}', {
          status: 401,
        });
      if (mode === "cancel") {
        controller.abort(new Error("Synthetic cancellation"));
        throw controller.signal.reason;
      }
      return chatResponse("");
    });
    if (mode === "empty")
      assert.equal(
        await f.inference.generate("Input", "model-old", controller.signal),
        "",
      );
    else
      await assert.rejects(
        f.inference.generate("Input", "model-old", controller.signal),
      );
    const listed = await new ModelRequestDebugStore(f.coldTrace()).control({
      action: "list",
      threadId: "",
    });
    assert.equal(listed.records?.length, 1);
    assert.equal(listed.records![0]!.dispatch, "observed");
    assert.equal(
      listed.records![0]!.sampleOutcome,
      mode === "empty"
        ? "completed"
        : mode === "error"
          ? "failed"
          : "cancelled",
    );
    assert.equal(f.settings.activeConfigurationOperations(), 0);
  }
});

test("configured probe empty responses, HTTP failures and cancellation retain outcome without hidden Threads", async (t) => {
  for (const mode of ["empty", "error", "cancel"] as const) {
    const controller = new AbortController();
    const f = await fixture(t, async () => {
      if (mode === "error")
        return new Response('{"error":{"message":"Synthetic denial"}}', {
          status: 401,
        });
      if (mode === "cancel") {
        controller.abort(new Error("Synthetic probe cancellation"));
        throw controller.signal.reason;
      }
      return chatResponse("");
    });
    const before = await readFile(f.profilePath, "utf8");
    const result = await f.settings.probeProviderModelImage(
      "synthetic",
      "model-old",
      { signal: controller.signal },
    );
    assert.equal(
      result.outcome,
      mode === "empty" ? "supported" : "inconclusive",
    );
    if (mode !== "empty")
      assert.equal(await readFile(f.profilePath, "utf8"), before);
    const listed = await new ModelRequestDebugStore(f.coldTrace()).control({
      action: "list",
      threadId: "",
    });
    assert.equal(listed.records?.length, 1);
    assert.equal(listed.records![0]!.purpose, "image-probe");
    assert.equal(listed.records![0]!.dispatch, "observed");
    assert.equal(
      listed.records![0]!.sampleOutcome,
      mode === "empty"
        ? "completed"
        : mode === "error"
          ? "failed"
          : "cancelled",
    );
    assert.equal(f.settings.activeConfigurationOperations(), 0);
  }
});

test("subscription titles persist the declared system prompt and revoke a selected auth session before dispatch", async (t) => {
  const jwt = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.synthetic`;
  let leases = 0;
  let fetches = 0;
  const f = await fixture(
    t,
    async (_url, init) => {
      fetches++;
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        `Bearer ${jwt}`,
      );
      return responsesResponse();
    },
    "responses",
    {
      login: async () => undefined,
      logout: async () => undefined,
      status: async () => ({
        authenticated: true,
        expired: false,
        accountId: "synthetic-account",
      }),
      acquireAccessLease: async () => {
        leases++;
        return { accessToken: jwt };
      },
    },
  );
  assert.equal(
    await f.inference.generate(
      "Untrusted excerpt",
      "model-old",
      new AbortController().signal,
    ),
    "Synthetic title",
  );
  const firstOwner = (await f.coldTrace().listThreadIds())[0]!;
  const bundle = await new FileItemListStore(
    path.join(f.dataDirectory, "context-bundles"),
  ).read(firstOwner);
  assert.equal(
    bundle.filter((item) => item.kind === "message" && item.role === "system")
      .length,
    1,
  );
  const compiled = compileItemList(bundle);
  const reader = new ModelRequestDebugStore(f.coldTrace());
  const summary = (
    await reader.control({ action: "list", threadId: firstOwner })
  ).records![0]!;
  const payload = JSON.parse(
    (
      await reader.control({
        action: "read",
        threadId: firstOwner,
        id: summary.id,
        view: "payload",
      })
    ).page!.text,
  );
  assert.equal(
    payload.instructions,
    compiled.messages
      .filter((m) => m.role === "system")
      .map((m) => ("text" in m ? m.text : ""))
      .join("\n\n"),
  );
  assert.equal(payload.input[0].role, "user");
  assert.doesNotMatch(payload.instructions, /Untrusted excerpt/u);
  const select = f.settings.titleModel.bind(f.settings);
  f.settings.titleModel = async (signal) => {
    const selected = await select(signal);
    const record = selected.trace.record.bind(selected.trace);
    let revoked = false;
    selected.trace.record = async (event) => {
      if (!revoked && event.type === "context_source") {
        revoked = true;
        await f.settings.logout();
      }
      return record(event);
    };
    return selected;
  };
  await assert.rejects(
    f.inference.generate("Blocked", "model-old", new AbortController().signal),
    /dispatch blocked/u,
  );
  assert.equal(
    leases,
    2,
    "Each selected sample freezes exactly one initial access lease",
  );
  assert.equal(fetches, 1);
  const all = (
    await new ModelRequestDebugStore(f.coldTrace()).control({
      action: "list",
      threadId: "",
    })
  ).records!;
  assert.equal(all.length, 2);
  const blocked = all.find((r) => r.dispatch === "blocked")!;
  assert.equal(blocked.sampleOutcome, "failed");
  assert.equal(blocked.preparedRequestCaptured, false);
  const blockedEvents = (await f.coldTrace().read(blocked.threadId)).records;
  assert.equal(
    (
      blockedEvents.find((event) => event.type === "model_dispatch_blocked")!
        .data as { reason: string }
    ).reason,
    "auth_session_changed",
  );
  assert.equal(f.settings.activeConfigurationOperations(), 0);
});

test("probe transport remains frozen across profile edits and stale capability results cannot overwrite the next configuration", async (t) => {
  const requests: Array<{ url: string; key: string | null; model: string }> =
    [];
  const f = await fixture(t, async (url, init) => {
    requests.push({
      url: String(url),
      key: new Headers(init?.headers).get("authorization"),
      model: JSON.parse(String(init?.body)).model,
    });
    return chatResponse("");
  });
  await assert.rejects(
    f.settings.probeProviderModelImage("synthetic", "model-old", {
      resolveTransport: async (provider) => {
        await f.settings.editProviderProfile(
          "synthetic",
          { ...provider, baseUrl: "https://new.synthetic.test/v1" },
          { apiKey: "new-synthetic-key" },
        );
        return undefined;
      },
    }),
    /changed during image capability probe/u,
  );
  const result = await f.settings.probeProviderModelImage(
    "synthetic",
    "model-new",
  );
  assert.equal(result.outcome, "supported");
  assert.deepEqual(requests, [
    {
      url: "https://old.synthetic.test/v1/chat/completions",
      key: "Bearer old-synthetic-key",
      model: "model-old",
    },
    {
      url: "https://new.synthetic.test/v1/chat/completions",
      key: "Bearer new-synthetic-key",
      model: "model-new",
    },
  ]);
  const provider = (
    await f.settings.publicSettings()
  ).profile.providerProfiles.find(
    (entry) => entry.providerProfileId === "synthetic",
  )!;
  assert.notEqual(
    provider.models.find((model) => model.id === "model-old")!.source,
    "probe",
  );
  assert.equal(
    provider.models.find((model) => model.id === "model-new")!.source,
    "probe",
  );
});

test("title context persistence failure is explicit and does not attempt transport", async (t) => {
  let fetches = 0;
  const f = await fixture(t, async () => {
    fetches++;
    return chatResponse();
  });
  const select = f.settings.titleModel.bind(f.settings);
  f.settings.titleModel = async (signal) => {
    const selected = await select(signal);
    selected.trace.record = async () => ({
      durability: "degraded",
      error: "Synthetic source disk failure",
    });
    return selected;
  };
  await assert.rejects(
    f.inference.generate("Input", "model-old", new AbortController().signal),
    /context source was not durable/u,
  );
  assert.equal(fetches, 0);
  assert.equal(f.settings.activeConfigurationOperations(), 0);
  assert.deepEqual(await f.coldTrace().listThreadIds(), []);
});
