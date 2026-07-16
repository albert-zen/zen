import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  consumeAppServerClientHandoff,
  DEFAULT_APP_SERVER_HOST,
  DEFAULT_APP_SERVER_PORT,
  readAppServerPort,
  readRemoteBindOptIn,
  writeAppServerClientHandoff
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

  it("hands a capability to a Node client exactly once", async () => {
    const root = await mkdtemp(join(tmpdir(), "zen-capability-"));
    const path = join(root, "app-server-client.json");
    const handoff = {
      baseUrl: "http://127.0.0.1:4321",
      capability: "handoff-capability-0123456789-abcdef-0123456789"
    };

    try {
      await writeAppServerClientHandoff(path, handoff);

      await expect(consumeAppServerClientHandoff(path)).resolves.toEqual(handoff);
      await expect(consumeAppServerClientHandoff(path)).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
