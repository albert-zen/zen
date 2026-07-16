// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type {
  AppServerClient,
  AppServerNotificationListener,
  AppServerRequestInput,
  AppServerResponse,
  AppServerSubscription
} from "../src/index.js";
import { WebUiClient } from "../src/index.js";
import { AgentWorkspace } from "../web/src/workspace.tsx";

describe("AgentWorkspace lifecycle", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it("owns one stream through StrictMode initial connect, reconnect, mode switch, and unmount", async () => {
    const clients: Array<{ readonly mode: "real" | "demo"; readonly transport: WorkspaceTransport }> = [];
    const createClient = (mode: "real" | "demo") => {
      const transport = new WorkspaceTransport();
      clients.push({ mode, transport });
      return new WebUiClient({ client: transport, mode });
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(React.createElement(React.StrictMode, undefined, React.createElement(AgentWorkspace, { createClient, initialMode: "real" })));
    });
    expect(activeStreams(clients)).toBe(1);

    await act(async () => {
      (container?.querySelector("#connect") as HTMLButtonElement).click();
    });
    expect(activeStreams(clients)).toBe(1);

    await act(async () => {
      const mode = container?.querySelector("#runtime-mode") as HTMLSelectElement;
      mode.value = "demo";
      mode.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(activeStreams(clients.filter((entry) => entry.mode === "real"))).toBe(0);
    expect(activeStreams(clients.filter((entry) => entry.mode === "demo"))).toBe(1);

    await act(async () => root?.unmount());
    root = undefined;
    expect(activeStreams(clients)).toBe(0);
  });
});

function activeStreams(clients: readonly { readonly transport: WorkspaceTransport }[]): number {
  return clients.reduce((total, entry) => total + entry.transport.activeSubscriptions, 0);
}

class WorkspaceTransport implements AppServerClient {
  activeSubscriptions = 0;

  async request(request: AppServerRequestInput): Promise<AppServerResponse> {
    if (request.method === "thread/list") {
      return { method: "thread/list", ok: true, result: { threads: [] } };
    }
    if (request.method === "thread/start" || request.method === "thread/read") {
      return {
        method: request.method,
        ok: true,
        result: { thread: { id: "thread-1", status: "idle", turns: [], items: [] } }
      } as AppServerResponse;
    }
    throw new Error(`Unexpected request: ${request.method}`);
  }

  subscribe(_listener: AppServerNotificationListener): AppServerSubscription {
    this.activeSubscriptions += 1;
    let closed = false;
    return () => {
      if (!closed) {
        closed = true;
        this.activeSubscriptions -= 1;
      }
    };
  }
}
