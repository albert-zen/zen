import { execFile, fork, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

import {
  consumeAppServerClientHandoff
} from "../src/app-server-config.js";
import {
  HttpAppServerClient,
  type AppServerNotification
} from "../src/index.js";

const execFileAsync = promisify(execFile);

describe("standalone App Server CLI", () => {
  beforeAll(async () => {
    await execFileAsync(
      process.execPath,
      [
        join(process.cwd(), "node_modules", "typescript", "bin", "tsc"),
        "-p",
        "tsconfig.build.json"
      ],
      { cwd: process.cwd() }
    );
  }, 30_000);

  it("rejects conflicting credential modes without logging the capability", async () => {
    const root = await mkdtemp(join(tmpdir(), "zen-app-server-cli-modes-"));
    const providedCapability =
      "provided-capability-0123456789-abcdef-0123456789";
    const child = fork(join(process.cwd(), "dist", "app-server-cli.js"), [], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ZEN_APP_SERVER_CAPABILITY: providedCapability,
        ZEN_APP_SERVER_CAPABILITY_DIR: root
      },
      silent: true
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });

    try {
      await waitForExit(child);

      expect(child.exitCode).not.toBe(0);
      expect(output).toContain(
        "Set exactly one of ZEN_APP_SERVER_CAPABILITY or ZEN_APP_SERVER_CAPABILITY_DIR"
      );
      expect(output).not.toContain(providedCapability);
      expect(await readdir(root)).toEqual([]);
    } finally {
      if (child.exitCode === null) {
        child.kill();
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes and claims one redacted generated-capability handoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "zen-app-server-cli-"));
    const handoffDirectory = join(root, "handoff");
    const configPath = join(root, "model-provider.json");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ZEN_APP_SERVER_CAPABILITY_DIR: handoffDirectory,
      ZEN_APP_SERVER_PORT: "0",
      ZEN_MODEL_PROVIDER_CONFIG: configPath
    };
    delete env.ZEN_APP_SERVER_CAPABILITY;
    delete env.ZEN_APP_SERVER_CAPABILITY_HANDOFF;
    await writeFile(
      configPath,
      JSON.stringify({
        providerName: "Test",
        baseUrl: "https://example.test/v1",
        apiKey: "test-key",
        model: "test-model"
      }),
      "utf8"
    );
    await mkdir(handoffDirectory);

    const child = fork(join(process.cwd(), "dist", "app-server-cli.js"), [], {
      cwd: process.cwd(),
      env,
      silent: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    try {
      await waitForOutput(child, () =>
        stdout.includes("Zen App Server listening at ")
      );
      const handoffMatches = [
        ...stdout.matchAll(/Zen App Server capability handoff: (.+)\r?\n/gu)
      ];

      expect(handoffMatches).toHaveLength(1);
      const handoffPath = handoffMatches[0]?.[1]?.trim();

      if (!handoffPath) {
        throw new Error(`CLI did not print a handoff path: ${stdout}`);
      }

      expect(await readdir(handoffDirectory)).toEqual([
        handoffPath.slice(handoffDirectory.length + 1)
      ]);
      const publishedContents = JSON.parse(
        await readFile(handoffPath, "utf8")
      ) as { readonly capability: string };
      const capability = publishedContents.capability;
      const clientOptions = await consumeAppServerClientHandoff(handoffPath);

      await expect(
        consumeAppServerClientHandoff(handoffPath)
      ).rejects.toMatchObject({ code: "ENOENT" });

      const notifications: AppServerNotification[] = [];
      const client = new HttpAppServerClient(clientOptions);
      const unsubscribe = client.subscribe((notification) => {
        notifications.push(notification);
      });

      try {
        const response = await client.request({ method: "thread/start" });

        expect(response).toEqual(
          expect.objectContaining({ method: "thread/start", ok: true })
        );
        await waitForNotification(
          notifications,
          (notification) => notification.type === "thread/started"
        );
      } finally {
        unsubscribe();
      }

      const replacement = `${JSON.stringify({
        replacement: true,
        ownershipMarker: "replacement-owner"
      })}\n`;
      await writeFile(handoffPath, replacement, { encoding: "utf8", flag: "wx" });
      child.send({ type: "shutdown" });
      await waitForExit(child);

      expect(child.exitCode).toBe(0);
      expect(await readFile(handoffPath, "utf8")).toBe(replacement);
      expect(`${stdout}\n${stderr}`).not.toContain(capability);
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await waitForExit(child).catch(() => undefined);
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

async function waitForOutput(
  child: ChildProcess,
  predicate: () => boolean
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }

    if (child.exitCode !== null) {
      throw new Error(`CLI exited before startup with code ${child.exitCode}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Timed out waiting for CLI startup output");
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for CLI exit"));
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function waitForNotification(
  notifications: readonly AppServerNotification[],
  predicate: (notification: AppServerNotification) => boolean
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (notifications.some(predicate)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Timed out waiting for App Server notification");
}
