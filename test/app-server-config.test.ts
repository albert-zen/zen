import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  consumeAppServerClientHandoff,
  cleanupPublishedAppServerClientHandoff,
  DEFAULT_APP_SERVER_HOST,
  DEFAULT_APP_SERVER_PORT,
  publishAppServerClientHandoff,
  readAppServerCredentialMode,
  readAppServerPort,
  readRemoteBindOptIn
} from "../src/app-server-config.js";

describe("App Server defaults", () => {
  it("uses the Web UI default URL as the CLI default endpoint", () => {
    expect(DEFAULT_APP_SERVER_HOST).toBe("127.0.0.1");
    expect(DEFAULT_APP_SERVER_PORT).toBe(3000);
    expect(readAppServerPort(undefined)).toBe(DEFAULT_APP_SERVER_PORT);
    expect(readAppServerPort("4321")).toBe(4321);
  });

  it("rejects invalid port overrides", () => {
    expect(() => readAppServerPort("not-a-port")).toThrow(
      "ZEN_APP_SERVER_PORT must be an integer from 0 to 65535"
    );
    expect(() => readAppServerPort("65536")).toThrow(
      "ZEN_APP_SERVER_PORT must be an integer from 0 to 65535"
    );
  });

  it("requires an explicit valid value for remote bind opt-in", () => {
    expect(readRemoteBindOptIn(undefined, "ZEN_APP_SERVER_ALLOW_REMOTE")).toBe(
      false
    );
    expect(readRemoteBindOptIn("0", "ZEN_APP_SERVER_ALLOW_REMOTE")).toBe(false);
    expect(readRemoteBindOptIn("1", "ZEN_APP_SERVER_ALLOW_REMOTE")).toBe(true);
    expect(readRemoteBindOptIn("true", "ZEN_APP_SERVER_ALLOW_REMOTE")).toBe(true);
    expect(() =>
      readRemoteBindOptIn("yes", "ZEN_APP_SERVER_ALLOW_REMOTE")
    ).toThrow("ZEN_APP_SERVER_ALLOW_REMOTE must be one of: 0, 1, false, true");
  });

  it("requires exactly one provided-capability or generated-handoff mode", () => {
    expect(
      readAppServerCredentialMode({
        ZEN_APP_SERVER_CAPABILITY:
          "provided-capability-0123456789-abcdef-0123456789"
      })
    ).toEqual({
      type: "provided",
      capability: "provided-capability-0123456789-abcdef-0123456789"
    });
    expect(
      readAppServerCredentialMode({
        ZEN_APP_SERVER_CAPABILITY_DIR: "D:\\secure-handoff"
      })
    ).toEqual({ type: "handoff", directory: "D:\\secure-handoff" });
    expect(() => readAppServerCredentialMode({})).toThrow(
      "Set exactly one of ZEN_APP_SERVER_CAPABILITY or ZEN_APP_SERVER_CAPABILITY_DIR"
    );
    expect(() =>
      readAppServerCredentialMode({
        ZEN_APP_SERVER_CAPABILITY:
          "provided-capability-0123456789-abcdef-0123456789",
        ZEN_APP_SERVER_CAPABILITY_DIR: "D:\\secure-handoff"
      })
    ).toThrow(
      "Set exactly one of ZEN_APP_SERVER_CAPABILITY or ZEN_APP_SERVER_CAPABILITY_DIR"
    );
  });

  it("publishes a unique complete handoff that a Node client claims once", async () => {
    const root = await mkdtemp(join(tmpdir(), "zen-capability-"));
    const handoff = {
      baseUrl: "http://127.0.0.1:4321",
      capability: "handoff-capability-0123456789-abcdef-0123456789"
    };

    try {
      const published = await publishAppServerClientHandoff(root, handoff);
      const files = await readdir(root);

      expect(published.path.startsWith(root)).toBe(true);
      expect(files).toEqual([published.path.slice(root.length + 1)]);
      expect(published.ownershipMarker).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      await expect(consumeAppServerClientHandoff(published.path)).resolves.toEqual(
        handoff
      );
      await expect(
        consumeAppServerClientHandoff(published.path)
      ).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cleans up only an artifact that still has its ownership marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "zen-capability-"));
    const handoff = {
      baseUrl: "http://127.0.0.1:4321",
      capability: "handoff-capability-0123456789-abcdef-0123456789"
    };

    try {
      const owned = await publishAppServerClientHandoff(root, handoff);
      await cleanupPublishedAppServerClientHandoff(owned);
      await expect(readFile(owned.path, "utf8")).rejects.toMatchObject({
        code: "ENOENT"
      });

      const replaced = await publishAppServerClientHandoff(root, handoff);
      const replacement = `${JSON.stringify({
        ...handoff,
        ownershipMarker: "replacement-owner"
      })}\n`;
      await rm(replaced.path);
      await writeFile(replaced.path, replacement, {
        encoding: "utf8",
        flag: "wx"
      });
      await cleanupPublishedAppServerClientHandoff(replaced);

      await expect(readFile(replaced.path, "utf8")).resolves.toBe(replacement);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
