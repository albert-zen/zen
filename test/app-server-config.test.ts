import { describe, expect, it } from "vitest";

import {
  DEFAULT_APP_SERVER_HOST,
  DEFAULT_APP_SERVER_PORT,
  readAppServerPort
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
});
