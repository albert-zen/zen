/// <reference path="../src/renderer/src/env.d.ts" />
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { SubscriptionUsageCard } from "../src/renderer/src/SubscriptionUsageCard.js";
import type { SubscriptionUsage } from "../src/main/subscription-usage.js";
const { act, createElement } = React;
const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
Object.assign(globalThis, {
  React,
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const usage: SubscriptionUsage = {
  accountId: "a",
  fetchedAt: 1800000000000,
  planType: null,
  limits: [
    {
      id: "codex",
      name: "Codex",
      primary: {
        usedPercent: 25,
        windowDurationSeconds: 18000,
        resetsAt: 1800000000,
      },
      secondary: {
        usedPercent: null,
        windowDurationSeconds: null,
        resetsAt: null,
      },
    },
  ],
};
test("quota UI queries after login, labels remaining and unknown, and clears failed refresh", async () => {
  let fail = false,
    calls = 0;
  Object.defineProperty(window, "zenx", {
    configurable: true,
    value: {
      settings: {
        readSubscriptionUsage: async () => {
          calls++;
          if (fail) throw new Error("not shown");
          return usage;
        },
      },
    },
  });
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () =>
      root.render(
        createElement(SubscriptionUsageCard, {
          providerProfileId: "profile",
          accountId: undefined,
          authenticated: false,
        }),
      ),
    );
    assert.equal(calls, 0);
    assert.match(document.body.textContent!, /Sign in/);
    await act(async () =>
      root.render(
        createElement(SubscriptionUsageCard, {
          providerProfileId: "profile",
          accountId: "a",
          authenticated: true,
        }),
      ),
    );
    assert.equal(calls, 1);
    assert.match(document.body.textContent!, /75% remaining/);
    assert.match(document.body.textContent!, /25% used/);
    assert.match(document.body.textContent!, /Remaining not provided/);
    assert.match(document.body.textContent!, /Reset time not provided/);
    assert.equal(document.querySelectorAll("progress").length, 1);
    fail = true;
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Refresh subscription usage"]',
        )!
        .click(),
    );
    assert.match(
      document.querySelector('[role="alert"]')!.textContent!,
      /Could not load/,
    );
    assert.doesNotMatch(document.body.textContent!, /75%|not shown/);
  } finally {
    await act(async () => root.unmount());
  }
});
test("quota UI never restores a previous account response after logout", async () => {
  let resolve!: (value: SubscriptionUsage) => void;
  Object.defineProperty(window, "zenx", {
    configurable: true,
    value: {
      settings: {
        readSubscriptionUsage: () =>
          new Promise<SubscriptionUsage>((r) => {
            resolve = r;
          }),
      },
    },
  });
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () =>
      root.render(
        createElement(SubscriptionUsageCard, {
          providerProfileId: "profile",
          accountId: "a",
          authenticated: true,
        }),
      ),
    );
    assert.match(document.body.textContent!, /Loading subscription/);
    await act(async () =>
      root.render(
        createElement(SubscriptionUsageCard, {
          providerProfileId: "profile",
          accountId: undefined,
          authenticated: false,
        }),
      ),
    );
    await act(async () => resolve(usage));
    assert.match(document.body.textContent!, /Sign in/);
    assert.doesNotMatch(document.body.textContent!, /75%/);
  } finally {
    await act(async () => root.unmount());
  }
});

test("missing windows and empty quota groups are hidden, including Pro without a short window", async () => {
  Object.defineProperty(window, "zenx", {
    configurable: true,
    value: {
      settings: {
        readSubscriptionUsage: async () => ({
          ...usage,
          planType: "pro",
          limits: [
            {
              id: "codex",
              name: "Codex",
              primary: null,
              secondary: {
                usedPercent: 10,
                windowDurationSeconds: 604800,
                resetsAt: null,
              },
            },
            {
              id: "empty",
              name: "Empty limit",
              primary: null,
              secondary: null,
            },
          ],
        }),
      },
    },
  });
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () =>
      root.render(
        createElement(SubscriptionUsageCard, {
          providerProfileId: "profile",
          accountId: "a",
          authenticated: true,
        }),
      ),
    );
    assert.match(document.body.textContent!, /7-day window/);
    assert.doesNotMatch(
      document.body.textContent!,
      /5-hour|Empty limit|Quota windows not provided/,
    );
  } finally {
    await act(async () => root.unmount());
  }
});
