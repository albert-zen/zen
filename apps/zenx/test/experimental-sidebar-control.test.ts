import assert from "node:assert/strict";
import test from "node:test";
import {
  ExperimentalSidebarControl,
  parseSidebarCommand,
  type SidebarClientIdentity,
} from "../src/main/experimental-sidebar-control.js";
import { experimentalSidebarView } from "../src/renderer/src/experimental-sidebar-view.js";
import type { ToolInvocation } from "../../../src/tool.js";

function fixture(enabled = true) {
  let identity: SidebarClientIdentity | null = {
    clientId: "window-1",
    generation: "connection-1:view-1",
    threadId: "thread-1",
  };
  const effects: unknown[] = [];
  const pages = [{ id: "plugin:rooms:main", title: "Rooms" }];
  const ports = {
    current: () => identity,
    pages: () => pages,
    show: (fullscreen?: boolean) => {
      effects.push(["show", fullscreen]);
    },
    readFile: async (threadId: string, path: string) => {
      effects.push(["read", threadId, path]);
      return { path };
    },
    createBrowserTab: async (threadId: string, url: string) => {
      effects.push(["browser", threadId, url]);
      return { id: "tab-1" };
    },
    selectFile: (file: unknown) => {
      effects.push(["file-selected", file]);
    },
    selectBrowserTab: (tab: unknown) => {
      effects.push(["browser-selected", tab]);
    },
    openPage: (id: string) => {
      effects.push(["page", id]);
    },
  };
  const policy = {
    authorize: async () => {
      effects.push("authorized");
    },
  };
  const control = new ExperimentalSidebarControl({
    enabled,
    authorize: () => policy.authorize(),
  });
  const client = experimentalSidebarView(ports);
  function invocation(args: Record<string, unknown>): ToolInvocation {
    return {
      callId: "provider-call",
      canonicalToolCallId: "canonical-call",
      threadId: "thread-1",
      cwd: "/workspace",
      name: "zenx_ui_experiment",
      arguments: args,
      signal: new AbortController().signal,
    };
  }
  async function invoke(args: Record<string, unknown>) {
    const call = invocation(args);
    control.bindInvocation(call, client);
    return await control.invoke(call);
  }
  return {
    control,
    client,
    effects,
    ports,
    pages,
    policy,
    invocation,
    invoke,
    setIdentity: (next: SidebarClientIdentity | null) => {
      identity = next;
    },
  };
}

test("disabled by default and no effect before explicit opt-in", async () => {
  const f = fixture(false);
  assert.throws(
    () => f.control.bindInvocation(f.invocation({ action: "show" }), f.client),
    /disabled/,
  );
  const control = new ExperimentalSidebarControl({ authorize: async () => {} });
  await assert.rejects(
    control.invoke(f.invocation({ action: "show" })),
    /disabled/,
  );
  assert.deepEqual(f.effects, []);
});

test("all allowlisted actions use bound Thread, Host policy and acknowledgments", async () => {
  const f = fixture();
  for (const args of [
    { action: "show" },
    { action: "set_fullscreen", fullscreen: true },
    { action: "set_fullscreen", fullscreen: false },
    { action: "open_file", path: "docs/a file.md" },
    { action: "open_website", url: "https://example.com/page" },
    { action: "open_page", pageId: "plugin:rooms:main" },
  ])
    assert.equal((await f.invoke(args)).status, "applied");
  assert.ok(
    f.effects.some(
      (e) => JSON.stringify(e) === '["read","thread-1","docs/a file.md"]',
    ),
  );
  assert.ok(
    f.effects.some(
      (e) =>
        JSON.stringify(e) ===
        '["browser","thread-1","https://example.com/page"]',
    ),
  );
  assert.equal(f.effects[0], "authorized");
  assert.deepEqual(await f.invoke({ action: "list_pages" }), {
    status: "listed",
    action: "list_pages",
    pages: f.pages,
  });
});

test("model cannot supply routing, code, commands or other actions", () => {
  for (const args of [
    { action: "show", clientId: "victim" },
    { action: "show", threadId: "victim" },
    { action: "open_page", pageId: "rooms", route: "/settings" },
    { action: "eval", code: "process.exit()" },
    { action: "constructor" },
    { action: "__proto__" },
    { action: "set_fullscreen", fullscreen: "yes" },
    { action: "open_file", path: "file:///private/a" },
    { action: "open_file", path: "bad\u0000path" },
    { action: "open_website", url: "javascript:alert(1)" },
    { action: "open_website", url: "file:///private/a" },
    { action: "open_website", url: "https://user:password@example.com" },
    { action: "open_page", pageId: "a".repeat(257) },
    { action: "open_file", path: "a".repeat(4097) },
  ])
    assert.throws(() => parseSidebarCommand(args));
});

test("unbound/cloned/cross-Thread invocations cannot target a client", async () => {
  const f = fixture();
  const call = f.invocation({ action: "show" });
  await assert.rejects(f.control.invoke(call), /binding/);
  f.control.bindInvocation(call, f.client);
  await assert.rejects(f.control.invoke({ ...call }), /binding/);
  assert.throws(
    () => f.control.bindInvocation({ ...call, threadId: "thread-2" }, f.client),
    /provenance/,
  );
  assert.throws(
    () =>
      f.control.bindInvocation(
        { ...call, canonicalToolCallId: undefined },
        f.client,
      ),
    /provenance/,
  );
  assert.throws(
    () =>
      f.control.bindInvocation({ ...call, trustedPluginUi: true }, f.client),
    /provenance/,
  );
  assert.deepEqual(f.effects, []);
});

test("same invocation never rebinds or replays after success or denial", async () => {
  const f = fixture();
  const call = f.invocation({ action: "show" });
  f.control.bindInvocation(call, f.client);
  assert.throws(() => f.control.bindInvocation(call, f.client), /already/);
  await f.control.invoke(call);
  await assert.rejects(f.control.invoke(call), /binding/);
  assert.throws(() => f.control.bindInvocation(call, f.client), /consumed/);
  f.policy.authorize = async () => {
    throw new Error("Host policy denied");
  };
  const denied = f.invocation({ action: "open_file", path: "../secret" });
  f.control.bindInvocation(denied, f.client);
  await assert.rejects(f.control.invoke(denied), /Host policy denied/);
  await assert.rejects(f.control.invoke(denied), /binding/);
  assert.deepEqual(f.effects, ["authorized", ["show", undefined]]);
});

test("disconnect, generation change, Thread switch, and changed call provenance reject before dispatch", async () => {
  for (const identity of [
    null,
    {
      clientId: "window-2",
      generation: "connection-1:view-1",
      threadId: "thread-1",
    },
    { clientId: "window-1", generation: "new", threadId: "thread-1" },
    {
      clientId: "window-1",
      generation: "connection-1:view-1",
      threadId: "thread-2",
    },
  ]) {
    const f = fixture();
    const call = f.invocation({ action: "show" });
    f.control.bindInvocation(call, f.client);
    f.setIdentity(identity);
    await assert.rejects(f.control.invoke(call), /disconnected or changed/);
    assert.deepEqual(f.effects, []);
  }
  const f = fixture();
  const call = f.invocation({ action: "show" });
  f.control.bindInvocation(call, f.client);
  call.canonicalToolCallId = "forged";
  await assert.rejects(f.control.invoke(call), /changed/);
});

test("revocation during authorization cannot reach the UI", async () => {
  const f = fixture();
  f.policy.authorize = async () => {
    f.setIdentity(null);
  };
  await assert.rejects(f.invoke({ action: "show" }), /changed/);
  assert.deepEqual(f.effects, []);
});

test("pending file/browser completion cannot select in a revoked view", async () => {
  const f = fixture();
  f.ports.readFile = async () => {
    f.setIdentity(null);
    return { path: "a.md" };
  };
  await assert.rejects(
    f.invoke({ action: "open_file", path: "a.md" }),
    /changed/,
  );
  assert.deepEqual(f.effects, ["authorized"]);
  const g = fixture();
  g.ports.createBrowserTab = async () => {
    g.setIdentity(null);
    return { id: "tab-created" };
  };
  await assert.rejects(
    g.invoke({ action: "open_website", url: "https://example.com" }),
    /changed/,
  );
  assert.deepEqual(g.effects, ["authorized"]);
});

test("display labels are not route IDs; stale or ambiguous page inventory fails", async () => {
  const f = fixture();
  await assert.rejects(
    f.invoke({ action: "open_page", pageId: "StartAgent" }),
    /Unknown page/,
  );
  f.pages.push({ id: "plugin:rooms:main", title: "Duplicate" });
  await assert.rejects(f.invoke({ action: "list_pages" }), /Ambiguous/);
  assert.deepEqual(f.effects, ["authorized", "authorized"]);
});

test("abort and missing acknowledgment never claim successful application", async () => {
  const f = fixture();
  const call = f.invocation({ action: "show" });
  const abort = new AbortController();
  call.signal = abort.signal;
  f.control.bindInvocation(call, f.client);
  abort.abort();
  await assert.rejects(f.control.invoke(call), /abort/i);
  const next = f.invocation({ action: "show" });
  f.control.bindInvocation(next, {
    ...f.client,
    dispatch: async () => undefined as never,
  });
  await assert.rejects(f.control.invoke(next), /uncertain/);
  await assert.rejects(f.control.invoke(next), /binding/);
});

test("existing workspace-file authorization still rejects escape and symlink escape", async () => {
  const { mkdtemp, mkdir, writeFile, symlink, rm } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readWorkspaceFile } = await import("../src/main/workspace-files.js");
  const root = await mkdtemp(join(tmpdir(), "sidebar-prototype-"));
  try {
    await mkdir(join(root, "workspace"));
    await writeFile(join(root, "secret.txt"), "never disclose");
    await writeFile(join(root, "workspace", "ok.txt"), "preview");
    await symlink(
      join(root, "secret.txt"),
      join(root, "workspace", "link.txt"),
    );
    const f = fixture();
    f.ports.readFile = async (_threadId, path) =>
      await readWorkspaceFile(join(root, "workspace"), path);
    await assert.rejects(
      f.invoke({ action: "open_file", path: "../secret.txt" }),
      /outside this workspace/,
    );
    await assert.rejects(
      f.invoke({ action: "open_file", path: "link.txt" }),
      /outside this workspace/,
    );
    assert.deepEqual(f.effects, ["authorized", "authorized"]);
    const result = await f.invoke({ action: "open_file", path: "ok.txt" });
    assert.equal(result.status, "applied");
    assert.ok(
      !JSON.stringify(result).includes("preview"),
      "file contents are not returned to the model",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Host browser denial propagates without selecting or opening side panel", async () => {
  const f = fixture();
  f.ports.createBrowserTab = async () => {
    throw new Error("Browser Host permission denied");
  };
  await assert.rejects(
    f.invoke({ action: "open_website", url: "https://example.com" }),
    /permission denied/,
  );
  assert.deepEqual(f.effects, ["authorized"]);
});

test("post-effect dispatch rejection reports uncertainty and never retries", async () => {
  const f = fixture();
  const call = f.invocation({
    action: "open_website",
    url: "https://example.com",
  });
  f.control.bindInvocation(call, {
    ...f.client,
    dispatch: async () => {
      f.effects.push("tab-created");
      throw new Error("renderer disconnected after creation");
    },
  });
  await assert.rejects(
    f.control.invoke(call),
    /outcome is uncertain.*renderer disconnected/,
  );
  await assert.rejects(f.control.invoke(call), /binding/);
  assert.deepEqual(f.effects, ["authorized", "tab-created"]);
});

test("confirmed Subagents target uses its current registered panel and no tool execution", async () => {
  const { experimentalSidebarPluginNavigation } =
    await import("../src/renderer/src/experimental-sidebar-view.js");
  const { readFile } = await import("node:fs/promises");
  const manifest = JSON.parse(
    await readFile(
      new URL(
        "../../../packages/zenx-subagents-plugin/zenx.plugin.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const panel = manifest.contributions.panels.find(
    (entry: { id: string }) => entry.id === "subagents",
  );
  assert.ok(
    panel,
    "current Subagents manifest must register the intended panel",
  );
  const snapshot = {
    pages: [],
    panels: [
      { ...panel, key: `${manifest.id}:${panel.id}`, pluginId: manifest.id },
    ],
  };
  const f = fixture();
  const navigation = experimentalSidebarPluginNavigation({
    snapshot: () => snapshot,
    navigatePage: (route) => {
      f.effects.push(["route", route]);
    },
    selectPanel: (tab) => {
      f.effects.push(["panel", tab]);
    },
    show: () => f.ports.show(),
  });
  f.ports.pages = () => [...navigation.pages()];
  f.ports.openPage = navigation.openPage;
  assert.deepEqual((await f.invoke({ action: "list_pages" })).pages, [
    { id: "panel:zenx-subagents:subagents", title: "Subagents" },
  ]);
  await f.invoke({
    action: "open_page",
    pageId: "panel:zenx-subagents:subagents",
  });
  assert.deepEqual(f.effects.slice(-2), [
    ["panel", "plugin:zenx-subagents:subagents"],
    ["show", undefined],
  ]);
  snapshot.panels = [];
  await assert.rejects(
    f.invoke({ action: "open_page", pageId: "panel:zenx-subagents:subagents" }),
    /Unknown page/,
  );
});
