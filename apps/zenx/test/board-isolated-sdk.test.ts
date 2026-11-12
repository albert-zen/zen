import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
import { isolatedDocument } from "../src/renderer/src/plugin-ui-host.js";

test("isolated SDK async interaction scopes its commands and always ends after rejection", async () => {
  const errors: unknown[] = [];
  const console = new VirtualConsole();
  console.on("jsdomError", (error) => errors.push(error));
  const calls: Array<Record<string, unknown>> = [];
  const dom = new JSDOM(
    isolatedDocument("<button>Custom</button>", {
      channel: "fixture",
      theme: "light",
      pluginId: "zenx-board",
      context: {},
      exportName: "board",
    }),
    {
      runScripts: "dangerously",
      virtualConsole: console,
      beforeParse(window) {
        const parent = {
          postMessage(request: Record<string, unknown>) {
            if (request.type !== "zenx-plugin-ui:request") return;
            calls.push(request);
            queueMicrotask(() =>
              window.dispatchEvent(
                new window.MessageEvent("message", {
                  source: parent as unknown as Window,
                  data: {
                    channel: "fixture",
                    type:
                      request.id === "fail"
                        ? "zenx-plugin-ui:error"
                        : "zenx-plugin-ui:result",
                    requestId: request.requestId,
                    value:
                      request.operation === "interaction.begin"
                        ? "opaque"
                        : "ok",
                    message: "synthetic failure",
                  },
                }),
              ),
            );
          },
        };
        Object.defineProperty(window, "parent", { value: parent });
      },
    },
  );
  try {
    const sdk = (
      dom.window as unknown as {
        zenxPluginUi: {
          interaction: {
            run(
              fn: (scope: {
                commands: {
                  execute(id: string, input?: unknown): Promise<unknown>;
                };
              }) => Promise<unknown>,
            ): Promise<unknown>;
          };
        };
      }
    ).zenxPluginUi;
    assert.ok(Boolean(sdk), "SDK initialized without script syntax errors");
    await assert.rejects(
      sdk.interaction.run(async ({ commands }) => {
        await commands.execute("first", { text: "custom" });
        await commands.execute("fail");
      }),
      /synthetic failure/,
    );
    assert.deepEqual(
      calls.map((call) => call.operation),
      [
        "interaction.begin",
        "commands.execute",
        "commands.execute",
        "interaction.end",
      ],
    );
    assert.equal(calls[1]?.interactionId, "opaque");
    assert.equal(calls[2]?.interactionId, "opaque");
    assert.equal(calls[3]?.id, "opaque");
    assert.deepEqual(errors, []);
  } finally {
    dom.window.close();
  }
});

test("private input witness is installed before custom HTML and synthetic focus/click/key cannot mint it", () => {
  const messages: Array<Record<string, unknown>> = [];
  const dom = new JSDOM(
    isolatedDocument(
      `<input id="field"><button id="button">Custom</button><script>
        window.bootstrapReady = Boolean(window.zenxPluginUi);
        document.getElementById('field').focus();
        document.getElementById('button').click();
        dispatchEvent(new Event('pointerdown'));
        dispatchEvent(new KeyboardEvent('keydown', {key:'Enter'}));
      </script>`,
      {
        channel: "fixture",
        theme: "dark",
        pluginId: "zenx-board",
        context: {},
        exportName: "board",
        interactionScope: "document:1",
      },
    ),
    {
      runScripts: "dangerously",
      beforeParse(window) {
        Object.defineProperty(window, "parent", {
          value: {
            postMessage(message: Record<string, unknown>) {
              messages.push(message);
            },
          },
        });
      },
    },
  );
  try {
    assert.equal(
      (dom.window as unknown as { bootstrapReady: boolean }).bootstrapReady,
      true,
    );
    assert.equal(messages[0]?.type, "zenx-plugin-ui:gesture-register");
    assert.equal(
      messages.filter((message) => message.type === "zenx-plugin-ui:gesture")
        .length,
      0,
    );
    const nonce = messages[0]?.nonce;
    assert.equal(typeof nonce, "string");
    assert.ok(
      !dom.serialize().includes(String(nonce)),
      "Private witness is not readable from document markup",
    );
    assert.ok(
      !JSON.stringify(
        (dom.window as unknown as { zenxPluginUi: unknown }).zenxPluginUi,
      ).includes(String(nonce)),
    );
  } finally {
    dom.window.close();
  }
});

test("scoped SDK methods cannot be reused after their callback ends", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const active = new Set<string>();
  const dom = new JSDOM(
    isolatedDocument("<button>Custom</button>", {
      channel: "fixture",
      theme: "light",
      pluginId: "zenx-board",
      context: {},
      exportName: "board",
    }),
    {
      runScripts: "dangerously",
      beforeParse(window) {
        const parent = {
          postMessage(request: Record<string, unknown>) {
            if (request.type !== "zenx-plugin-ui:request") return;
            calls.push(request);
            if (request.operation === "interaction.begin") active.add("token");
            if (request.operation === "interaction.end")
              active.delete(String(request.id));
            const denied =
              request.operation === "commands.execute" &&
              !active.has(String(request.interactionId));
            queueMicrotask(() =>
              window.dispatchEvent(
                new window.MessageEvent("message", {
                  source: parent as unknown as Window,
                  data: {
                    channel: "fixture",
                    requestId: request.requestId,
                    type: denied
                      ? "zenx-plugin-ui:error"
                      : "zenx-plugin-ui:result",
                    value:
                      request.operation === "interaction.begin"
                        ? "token"
                        : "ok",
                    message: "Interaction expired",
                  },
                }),
              ),
            );
          },
        };
        Object.defineProperty(window, "parent", { value: parent });
      },
    },
  );
  try {
    type Scoped = { commands: { execute(id: string): Promise<unknown> } };
    const sdk = (
      dom.window as unknown as {
        zenxPluginUi: {
          interaction: {
            run(
              callback: (scope: Scoped) => Promise<unknown>,
            ): Promise<unknown>;
          };
        };
      }
    ).zenxPluginUi;
    let retained: Scoped | undefined;
    assert.equal(
      await sdk.interaction.run(async (scope) => {
        retained = scope;
        return await scope.commands.execute("first");
      }),
      "ok",
    );
    await assert.rejects(retained!.commands.execute("late"), /expired/);
    assert.deepEqual(
      calls.map((call) => call.operation),
      [
        "interaction.begin",
        "commands.execute",
        "interaction.end",
        "commands.execute",
      ],
    );
    assert.equal(
      calls.at(-1)?.interactionId,
      "token",
      "Each effect retains its own scope; it never falls back to a fresh gesture",
    );
  } finally {
    dom.window.close();
  }
});

test("isolated SDK applies dark/light/dark and document-scope updates without replacing custom content", () => {
  const messages: Array<Record<string, unknown>> = [];
  const dom = new JSDOM(
    isolatedDocument('<input id="draft" value="user text">', {
      channel: "fixture",
      theme: "dark",
      pluginId: "zenx-board",
      context: {},
      exportName: "board",
      appearance: {
        version: 1,
        reducedMotion: false,
        variables: { "--color-text-primary": "white" },
      },
    }),
    {
      runScripts: "dangerously",
      beforeParse(window) {
        Object.defineProperty(window, "parent", {
          value: {
            postMessage(message: Record<string, unknown>) {
              messages.push(message);
            },
          },
        });
      },
    },
  );
  try {
    const input = dom.window.document.getElementById("draft");
    const sdk = (
      dom.window as unknown as {
        zenxPluginUi: {
          theme: string;
          commands: { execute(id: string): Promise<unknown> };
        };
      }
    ).zenxPluginUi;
    for (const [revision, theme] of ["dark", "light", "dark"].entries()) {
      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          source: dom.window.parent,
          data: {
            channel: "fixture",
            type: "zenx-plugin-ui:update",
            theme,
            context: {},
            interactionScope: `document:${revision}`,
            appearance: {
              version: 1,
              reducedMotion: false,
              variables: {
                "--color-text-primary": theme === "dark" ? "white" : "black",
              },
            },
          },
        }),
      );
      assert.equal(sdk.theme, theme);
      void sdk.commands.execute("draft");
      assert.equal(messages.at(-1)?.interactionScope, `document:${revision}`);
      assert.equal(dom.window.document.documentElement.dataset.theme, theme);
      assert.equal(
        dom.window.document.documentElement.style.colorScheme,
        theme,
      );
      assert.equal(
        dom.window.document.documentElement.style.getPropertyValue(
          "--color-text-primary",
        ),
        theme === "dark" ? "white" : "black",
      );
      assert.equal(dom.window.document.getElementById("draft"), input);
      assert.equal((input as HTMLInputElement).value, "user text");
    }
  } finally {
    dom.window.close();
  }
});
