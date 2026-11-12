import assert from "node:assert/strict";
import test from "node:test";
import { parseFleetConfig } from "../src/main/fleet.js";

const hosting = {
  enabled: false,
  bindAddress: "127.0.0.1",
  port: 443,
  tlsCertificateFile: "",
  tlsKeyFile: "",
  access: "read",
};

test("Fleet retains the explicit Android Origin endpoint including the canonical HTTPS port", () => {
  const config = parseFleetConfig({
    version: 1,
    devices: [],
    hosting: { ...hosting, originEndpoint: "https://localhost:443" },
  });
  assert.equal(config.hosting!.originEndpoint, "https://localhost:443");
  assert.equal(
    parseFleetConfig({ version: 1, devices: [], hosting }).hosting!
      .originEndpoint,
    undefined,
  );
});

test("Fleet rejects ambiguous Android Origin endpoints and mismatched bound ports", () => {
  for (const originEndpoint of [
    "https://localhost",
    "https://localhost:0443",
    "https://localhost:444",
    "https://localhost:443/",
    "https://user@localhost:443",
    "https://localhost:443/path",
    "https://localhost:443?x=1",
    "http://localhost:443",
    "https://*.example:443",
    "https://xn--bcher-kva.example:443",
    "https://127.1:443",
    "https://[::1]:443",
    "https://localhost:65536",
  ])
    assert.throws(
      () =>
        parseFleetConfig({
          version: 1,
          devices: [],
          hosting: { ...hosting, originEndpoint },
        }),
      /Origin/u,
      originEndpoint,
    );
});
