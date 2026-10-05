import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const checkout = new URL("../../../", import.meta.url);
const require = createRequire(new URL("package.json", checkout));
const { JSDOM } = require("jsdom");
const React = require("react");
const { act, createElement: h } = React;
const ts = require("typescript");
await import(new URL("apps/zenx/test/dom-primitives.ts", checkout));
const bootstrap = new JSDOM('<div id="root"></div>', {
  url: "https://zenx.test",
});
Object.assign(globalThis, {
  window: bootstrap.window,
  document: bootstrap.window.document,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import(require.resolve("react-dom/client"));
const { i18n, resources } = await import(
  new URL("apps/zenx/src/renderer/src/i18n.ts", checkout)
);
const { FleetComposerSurface } = await import(
  new URL("apps/zenx/src/renderer/src/FleetComposerSurface.tsx", checkout)
);
const { FleetConnectionSetup, FleetInvitationIssuer } = await import(
  new URL("apps/zenx/src/renderer/src/FleetOnboarding.tsx", checkout)
);
const { FleetHistory } = await import(
  new URL("apps/zenx/src/renderer/src/FleetHistory.tsx", checkout)
);
const fleetEntries = (catalog) =>
  Object.fromEntries(
    Object.entries(catalog).filter(([key]) =>
      /^fleet(?:Composer|Onboarding|History)\./u.test(key),
    ),
  );
const additions = {
  en: fleetEntries(resources.en.settings),
  zhCN: fleetEntries(resources["zh-CN"].settings),
};

test("Fleet catalogs have complete key and interpolation parity; components have no literal English JSX or aria labels", async () => {
  assert.deepEqual(
    Object.keys(additions.en).sort(),
    Object.keys(additions.zhCN).sort(),
  );
  const placeholders = (value) =>
    [...value.matchAll(/\{\{\s*([^},\s]+)[^}]*\}\}/gu)]
      .map((match) => match[1])
      .sort();
  const used = new Set();
  for (const [key, value] of Object.entries(additions.en)) {
    assert.ok(additions.zhCN[key].trim(), key);
    assert.deepEqual(
      placeholders(value),
      placeholders(additions.zhCN[key]),
      key,
    );
  }
  for (const name of [
    "FleetComposerSurface.tsx",
    "FleetOnboarding.tsx",
    "FleetHistory.tsx",
  ]) {
    const path = new URL("apps/zenx/src/renderer/src/" + name, checkout);
    const source = await readFile(path, "utf8");
    const ast = ts.createSourceFile(
      name,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    assert.equal(ast.parseDiagnostics.length, 0, name);
    function visit(node) {
      if (
        ts.isStringLiteral(node) &&
        /^(?:settings:)?fleet(?:Composer|Onboarding|History)\./u.test(node.text)
      ) {
        const key = node.text.replace(/^settings:/u, "");
        assert.ok(Object.hasOwn(additions.en, key), `${name}: ${node.text}`);
        used.add(key);
      }
      if (ts.isJsxText(node))
        assert.doesNotMatch(node.text, /[A-Za-z]/u, `${name}: ${node.text}`);
      if (
        ts.isJsxAttribute(node) &&
        node.name.getText(ast) === "aria-label" &&
        node.initializer &&
        ts.isStringLiteral(node.initializer)
      ) {
        assert.doesNotMatch(
          node.initializer.text,
          /[A-Za-z]/u,
          `${name}: literal aria-label`,
        );
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  assert.deepEqual(
    [...used].sort(),
    Object.keys(additions.en).sort(),
    "no unreferenced catalog additions",
  );
});

const snapshot = {
  revision: 1,
  config: {
    version: 1,
    devices: [
      {
        id: "remote-id",
        label: "Remote user label 原文",
        description: "Remote user description 原文",
        transport: "https",
        endpoint: "https://remote.example",
        hostId: "host-id",
        access: "control",
      },
    ],
    hosting: {
      enabled: true,
      bindAddress: "127.0.0.1",
      port: 3940,
      tlsCertificateFile: "/fixture/cert.pem",
      tlsKeyFile: "/fixture/key.pem",
      originEndpoint: "https://remote.example",
      access: "control",
      shellEnabled: true,
      relayEndpoint: "https://relay.example",
    },
  },
  host: {
    enabled: true,
    hostId: "host-id",
    url: "https://127.0.0.1:3940",
    clients: [],
  },
};
const limits = [
  "configuredPeersOnly",
  "httpsReachability",
  "networkPreparation",
  "relayTrust",
  "invitationLimits",
].map((key) => additions.en["fleetOnboarding." + key]);
const history = {
  items: [
    {
      type: "user_message",
      item: {
        content: [
          { type: "text", text: "Keep my remote words 原文" },
          { type: "image", path: "/remote/secret.png" },
        ],
      },
    },
    {
      type: "reasoning",
      item: {
        contentVisibility: "opaque",
        text: "DO NOT DISPLAY PRIVATE REASONING",
      },
    },
    { type: "model_usage", item: { inputTokens: 17, outputTokens: 23 } },
    { type: "turn_completed", item: { status: "failed" } },
    { type: "constructor" },
    {
      type: "tool_call",
      item: { name: "raw_tool_name", arguments: { path: "/remote/path" } },
    },
  ],
};

test("mounted Fleet surfaces switch language without changing drafts, user names, remote content, API identifiers or confirmations", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.test",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
  });
  const creates = [],
    sends = [];
  let failRead = false;
  const api = {
    status: async () => snapshot,
    save: async () => {},
    pair: async () => {},
    remove: async () => {},
    test: async () => {},
    invoke: async () => {},
    hostPair: async () => ({ hostId: "host-id", code: "code" }),
    revoke: async () => {},
    hostInvitation: async () => {
      throw new Error("must not issue without confirmation");
    },
    readiness: async () => ({
      prerequisites: {
        credentialEncryption: true,
        trustedEndpointConfigured: true,
      },
      host: { enabled: true },
      limits: [...limits, "constructor", "Unknown diagnostic remains raw"],
    }),
    catalog: async () => ({
      machine: {
        ...snapshot.config.devices[0],
        key: "raw-device-key",
        shellEnabled: false,
      },
      workspaces: [{ id: "raw-workspace-id", label: "Remote workspace 原文" }],
      models: [
        {
          id: "provider::raw-model-id",
          label: "Provider model 原文",
          isDefault: true,
          efforts: [],
          defaultEffort: null,
        },
      ],
    }),
    listThreads: async () => ({
      threads: [
        { id: "raw-thread", label: "Raw thread name 原文", status: "idle" },
      ],
      truncated: false,
    }),
    createThread: async (input) => {
      creates.push(input);
      return {
        deviceId: input.deviceId,
        deviceKey: input.deviceKey,
        workspace: input.workspace,
        threadId: "raw-thread",
        hostId: "host-id",
      };
    },
    sendThread: async (input) => {
      sends.push(input);
    },
    readThread: async () => {
      if (failRead) throw new Error("Provider diagnostic: raw English 原文");
      return history;
    },
    threadStatus: async () => ({ status: "idle" }),
  };
  Object.assign(dom.window, { zenx: { fleet: api } });
  const root = createRoot(document.getElementById("root"));
  const button = (label) => {
    const result = [...document.querySelectorAll("button")].find(
      (node) => node.textContent?.trim() === label,
    );
    assert.ok(result, label);
    return result;
  };
  const click = async (label) =>
    act(async () => {
      button(label).click();
      await Promise.resolve();
    });
  const fill = async (field, value) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      ).set.call(field, value);
      field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  const chooseMachine = async () => {
    const field = document.querySelector(
      ".fleet-machine-strip button.ui-select",
    );
    await act(async () => {
      field.focus();
      field.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
        }),
      );
    });
    const option = document.querySelector(
      '[role="option"][data-value="remote-id"]',
    );
    assert.ok(option);
    await act(async () => {
      option.focus();
      option.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
        }),
      );
    });
  };
  function Host() {
    const [draft, setDraft] = React.useState("Keep draft unchanged 原文");
    return h(
      React.Fragment,
      {},
      h(FleetComposerSurface, {
        text: draft,
        onTextChange: setDraft,
        children: h("div", {}, "local child content"),
      }),
      h(FleetConnectionSetup, {
        api,
        snapshot,
        disabled: false,
        onBusy() {},
        onChanged: async () => {},
      }),
      h(FleetInvitationIssuer, {
        api,
        snapshot,
        disabled: false,
        hostingDirty: false,
        onBusy() {},
        onHostStatus() {},
      }),
      h("div", { id: "history-probe" }, h(FleetHistory, { value: history })),
    );
  }
  try {
    await i18n.changeLanguage("en");
    await act(async () => root.render(h(Host)));
    assert.equal(
      document.querySelector('[aria-label="Invitation machine name"]').value,
      "This machine",
    );
    assert.equal(button("Create invitation").disabled, true);
    await click("Check this machine’s setup");
    await click("Use invitation");
    await fill(
      document.querySelector('[aria-label="Invitation"]'),
      "secret-invalid-do-not-echo",
    );
    await click("Review invitation");
    assert.match(document.body.textContent, /Invalid Fleet invitation/u);
    await act(async () => i18n.changeLanguage("zh-CN"));
    assert.match(document.body.textContent, /Fleet 邀请无效/u);
    assert.doesNotMatch(document.body.textContent, /secret-invalid/u);
    assert.equal(
      document.querySelector('[aria-label="邀请中的机器名称"]').value,
      "本机",
    );
    assert.equal(button("创建邀请").disabled, true);
    assert.match(document.body.textContent, /凭证存储：就绪/u);
    assert.match(document.body.textContent, /仅发现用户已配置/u);
    assert.match(document.body.textContent, /Unknown diagnostic remains raw/u);
    assert.match(
      document.getElementById("history-probe").textContent,
      /不显示私有推理内容/u,
    );
    assert.match(
      document.getElementById("history-probe").textContent,
      /输入 17 \/ 输出 23/u,
    );
    assert.match(
      document.getElementById("history-probe").textContent,
      /轮次 失败/u,
    );
    assert.match(
      document.getElementById("history-probe").textContent,
      /Keep my remote words 原文/u,
    );
    assert.match(
      document.getElementById("history-probe").textContent,
      /远程图片附件/u,
    );
    assert.match(
      document.getElementById("history-probe").textContent,
      /constructor/u,
    );
    assert.match(
      document.getElementById("history-probe").textContent,
      /raw_tool_name/u,
    );
    assert.doesNotMatch(
      document.getElementById("history-probe").textContent,
      /DO NOT DISPLAY PRIVATE REASONING|secret\.png/u,
    );
    await fill(
      document.querySelector('[aria-label="邀请中的机器名称"]'),
      "Edited machine name 原文",
    );
    await chooseMachine();
    const draft = document.querySelector(".fleet-remote-conversation textarea");
    assert.equal(draft.value, "Keep draft unchanged 原文");
    assert.match(document.body.textContent, /Remote user description 原文/u);
    await act(async () => i18n.changeLanguage("en"));
    assert.equal(
      document.querySelector(".fleet-remote-conversation textarea"),
      draft,
      "do not remount draft",
    );
    assert.equal(draft.value, "Keep draft unchanged 原文");
    assert.equal(
      document.querySelector('[aria-label="Invitation machine name"]').value,
      "Edited machine name 原文",
    );
    await click("Start on selected machine");
    assert.equal(creates.length, 1);
    assert.deepEqual(creates[0], {
      deviceId: "remote-id",
      deviceKey: "raw-device-key",
      workspace: "raw-workspace-id",
      model: "provider::raw-model-id",
    });
    assert.equal(sends[0].text, "Keep draft unchanged 原文");
    await act(async () => i18n.changeLanguage("zh-CN"));
    assert.match(document.body.textContent, /快照检查时间/u);
    assert.match(
      document.querySelector(".fleet-remote-conversation").textContent,
      /空闲/u,
    );
    failRead = true;
    await click("刷新远程会话");
    assert.match(
      document.querySelector(".fleet-remote-conversation").textContent,
      /上次快照可能已过时/u,
    );
    assert.match(
      document.querySelector(".fleet-remote-conversation").textContent,
      /Provider diagnostic: raw English 原文/u,
    );
    await act(async () => i18n.changeLanguage("en"));
    assert.match(
      document.querySelector(".fleet-remote-conversation").textContent,
      /last snapshot may be stale/u,
    );
    assert.match(
      document.querySelector(".fleet-remote-conversation").textContent,
      /No operation was automatically retried/u,
    );
    assert.equal(
      sends.length,
      1,
      "language changes and read errors never retry sends",
    );
  } finally {
    await act(async () => root.unmount());
    await i18n.changeLanguage("en");
    dom.window.close();
  }
});
