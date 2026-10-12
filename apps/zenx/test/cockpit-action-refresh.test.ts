import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { Cockpit } from "../src/renderer/src/Cockpit.js";
import { createCockpitHost } from "./fixtures/cockpit-host.js";

for (const operation of [
  "run",
  "guide",
  "interrupt",
  "failed-refresh",
  "leave",
] as const) {
  test(`Cockpit ${operation} invalidates a pending pre-action read and bounds the trailing refresh`, async () => {
    const host = await createCockpitHost();
    const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    // No poll can rescue the race. Accepted actions must refresh even while hidden.
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    let reads = 0;
    let inFlight = 0;
    let maximumInFlight = 0;
    let release: () => void = () => {};
    let captured = false;
    Object.assign(window, {
      zenx: {
        protocol: {
          request: async (
            method: Parameters<typeof host.client.request>[0],
            params: Parameters<typeof host.client.request>[1],
          ) => {
            if (method !== "zen/thread/read")
              return host.client.request(method, params);
            const request = ++reads;
            maximumInFlight = Math.max(maximumInFlight, ++inFlight);
            try {
              if (request === 3 && operation === "failed-refresh")
                throw new Error("Post-action read unavailable");
              assert.ok(
                "threadId" in params && typeof params.threadId === "string",
              );
              const result = await host.client.request(method, {
                threadId: params.threadId,
              });
              if (request === 2) {
                captured = true;
                await new Promise<void>((resolve) => {
                  release = resolve;
                });
              }
              return result;
            } finally {
              inFlight--;
            }
          },
        },
      },
    });
    const root = createRoot(document.getElementById("root")!);
    let mounted = true;
    const settle = async () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
    const button = (text: string) => {
      const result = [...document.querySelectorAll("button")].find((entry) =>
        entry.textContent?.includes(text),
      );
      assert.ok(result, text);
      return result;
    };
    const click = async (text: string) =>
      act(async () => {
        button(text).click();
      });
    try {
      if (operation === "guide" || operation === "interrupt")
        await host.appServer.startTurn(host.threadId, "keep running");
      const summaries = await host.appServer.listThreadSummaries();
      await act(async () =>
        root.render(
          React.createElement(Cockpit, {
            summaries,
            approvals: new Set<string>(),
            connected: true,
            loading: false,
            overviewReadAt: Date.now(),
            error: null,
            onRefresh() {},
            onOpenThread() {},
          }),
        ),
      );
      await click("Verify the release evidence");
      await settle();
      await click("Refresh task");
      while (!captured) await settle();
      if (operation === "interrupt") await click("Interrupt Turn");
      else {
        const textarea = document.querySelector("textarea")!;
        await act(async () => {
          Object.getOwnPropertyDescriptor(
            dom.window.HTMLTextAreaElement.prototype,
            "value",
          )!.set!.call(textarea, "keep running");
          textarea.dispatchEvent(
            new dom.window.Event("input", { bubbles: true }),
          );
          textarea.dispatchEvent(
            new dom.window.Event("change", { bubbles: true }),
          );
        });
        await act(async () => {
          document.querySelector("form")!.dispatchEvent(
            new dom.window.Event("submit", {
              bubbles: true,
              cancelable: true,
            }),
          );
        });
      }
      await settle();
      assert.match(document.body.textContent!, /accepted by Host/);
      assert.equal(reads, 2, "one pre-action read remains in flight");
      assert.equal(
        document.querySelector<HTMLButtonElement>('button[type="submit"]')!
          .disabled,
        true,
        "pre-action controls cannot become fresh after acceptance",
      );
      assert.match(
        document.querySelector(".cockpit-status")!.textContent!,
        /Unknown \/ stale/,
      );
      // Repeated refresh clicks coalesce with the one action refresh.
      await click("Refresh task");
      await click("Refresh task");
      if (operation === "leave") {
        await act(async () => root.unmount());
        mounted = false;
      }
      await act(async () => release());
      await settle();
      assert.equal(reads, operation === "leave" ? 2 : 3);
      assert.equal(maximumInFlight, 1);
      if (operation === "failed-refresh") {
        assert.match(
          document.body.textContent!,
          /Post-action read unavailable/,
        );
        assert.equal(
          document.querySelector<HTMLButtonElement>('button[type="submit"]')!
            .disabled,
          true,
        );
        await click("Refresh task");
        await settle();
        assert.equal(reads, 4);
        assert.ok(button("Guide active Turn"));
      } else if (operation === "run" || operation === "guide") {
        assert.ok(button("Guide active Turn"));
        assert.match(
          document.querySelector(".cockpit-status")!.textContent!,
          /^Running$/,
        );
      } else if (operation === "interrupt") {
        assert.ok(button("Run Agent"));
        assert.equal(
          (await host.appServer.readThread(host.threadId)).turns.at(-1)?.status,
          "interrupted",
        );
      }
    } finally {
      release();
      const active = (
        await host.appServer.readThread(host.threadId)
      ).turns.find((turn) => turn.status === "inProgress");
      if (active)
        await host.client.request("turn/interrupt", {
          threadId: host.threadId,
          turnId: active.id,
        });
      host.completeWaitingTurn();
      if (mounted) await act(async () => root.unmount());
      dom.window.close();
      await host.close();
    }
  });
}
