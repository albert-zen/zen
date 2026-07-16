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

describe("workspace external-store lifecycle", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it("keeps one stream through StrictMode reconnect, mode switch, and unmount", async () => {
    const firstTransport = new LifecycleClient();
    const secondTransport = new LifecycleClient();
    const first = new WebUiClient({ client: firstTransport, mode: "real" });
    const second = new WebUiClient({ client: secondTransport, mode: "demo" });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(React.createElement(React.StrictMode, undefined, React.createElement(Probe, { client: first })));
    });
    expect(firstTransport.activeSubscriptions).toBe(1);

    await act(async () => {
      await first.connect();
    });
    expect(firstTransport.activeSubscriptions).toBe(1);

    await act(async () => {
      root?.render(React.createElement(React.StrictMode, undefined, React.createElement(Probe, { client: second })));
    });
    expect(firstTransport.activeSubscriptions).toBe(0);
    expect(secondTransport.activeSubscriptions).toBe(1);

    await act(async () => root?.unmount());
    root = undefined;
    expect(secondTransport.activeSubscriptions).toBe(0);
  });
});

function Probe({ client }: { readonly client: WebUiClient }): React.ReactElement {
  const subscribe = React.useCallback((notify: () => void) => client.subscribe(() => notify()), [client]);
  const getSnapshot = React.useCallback(() => client.getSnapshot(), [client]);
  React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  React.useEffect(() => {
    void client.connect();
    return () => client.dispose();
  }, [client]);
  return React.createElement("div");
}

class LifecycleClient implements AppServerClient {
  activeSubscriptions = 0;

  async request(request: AppServerRequestInput): Promise<AppServerResponse> {
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
