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
