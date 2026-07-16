import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createServer as createViteServer } from "vite";

import {
  AppServer,
  serveAppServerHttpTransport,
  type ModelGateway
} from "../src/index.js";
import { writeAppServerClientHandoff } from "../src/app-server-config.js";

describe("Web development App Server proxy", () => {
  it("injects the capability for same-origin requests and event streams", async () => {
    const appServer = new AppServer({
      threadManagerOptions: {
        generateThreadId: () => "thread-1",
        generateRunId: () => "run-1",
        generateTurnId: () => "turn-1",
        generateItemId: () => "item-1",
        clock: () => 1000,
        runtimeFactory: () => ({
          model: {
            async *generate() {
              yield { type: "message.completed", content: "unused" };
            }
          } satisfies ModelGateway
        })
      }
    });
    const transport = await serveAppServerHttpTransport({ appServer });
    const root = await mkdtemp(join(tmpdir(), "zen-web-proxy-"));
    const handoffPath = join(root, "app-server-client.json");
    const previousCapability = process.env.ZEN_APP_SERVER_CAPABILITY;
    const previousHandoffPath = process.env.ZEN_APP_SERVER_CAPABILITY_FILE;
    let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;

    try {
      await writeAppServerClientHandoff(handoffPath, {
        baseUrl: transport.url,
        capability: transport.capability
      });
      delete process.env.ZEN_APP_SERVER_CAPABILITY;
      process.env.ZEN_APP_SERVER_CAPABILITY_FILE = handoffPath;
      vite = await createViteServer({
        configFile: "web/vite.config.ts",
        logLevel: "silent",
        server: {
          host: "127.0.0.1",
          port: 0,
          strictPort: true
        }
      });
      restoreEnvironment(
        previousCapability,
        previousHandoffPath
      );
      await vite.listen();
      const address = vite.httpServer?.address() as AddressInfo;
      const browserOrigin = `http://127.0.0.1:${address.port}`;
      const eventResponse = await fetch(new URL("/events", browserOrigin));

      expect(eventResponse.status).toBe(200);

      const notificationPromise = readSseNotification(eventResponse);
      const requestResponse = await fetch(new URL("/request", browserOrigin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "thread/start" })
      });

      expect(requestResponse.status).toBe(200);
      await expect(requestResponse.json()).resolves.toEqual(
        expect.objectContaining({ method: "thread/start", ok: true })
      );
      await expect(notificationPromise).resolves.toEqual(
        expect.objectContaining({
          type: "thread/started",
          thread: expect.objectContaining({ id: "thread-1" })
        })
      );
    } finally {
      restoreEnvironment(previousCapability, previousHandoffPath);
      await vite?.close();
      await transport.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function restoreEnvironment(
  capability: string | undefined,
  handoffPath: string | undefined
): void {
  if (capability === undefined) {
    delete process.env.ZEN_APP_SERVER_CAPABILITY;
  } else {
    process.env.ZEN_APP_SERVER_CAPABILITY = capability;
  }

  if (handoffPath === undefined) {
    delete process.env.ZEN_APP_SERVER_CAPABILITY_FILE;
  } else {
    process.env.ZEN_APP_SERVER_CAPABILITY_FILE = handoffPath;
  }
}

async function readSseNotification(response: Response): Promise<unknown> {
  if (!response.body) {
    throw new Error("Proxy event stream did not include a body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const result = await reader.read();

      if (result.done) {
        throw new Error("Proxy event stream ended before a notification");
      }

      buffer += decoder.decode(result.value, { stream: true }).replaceAll("\r\n", "\n");

      for (const event of buffer.split("\n\n")) {
        const data = event
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trimStart())
          .join("\n");

        if (data) {
          return JSON.parse(data) as unknown;
        }
      }
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
