import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeFleetInvitation,
  parseFleetInvitation,
  type FleetInvitation,
} from "../src/fleet-invitation.js";

const invitation = (): FleetInvitation => ({
  version: 1,
  hostId: "fixture-host",
  endpoint: "https://host.example:8443",
  label: "Work computer",
  expiresAt: Date.now() + 299_000,
  access: "control",
  shellEnabled: true,
  code: "fixture_one_use_pairing_code_12345678901234567",
});

test("Fleet invitation round-trip preserves preview facts without changing authority", () => {
  const input = invitation();
  const encoded = encodeFleetInvitation(input);
  assert.match(encoded, /^zenx-fleet:v1:/u);
  assert.equal(encoded.includes(input.code), false);
  assert.deepEqual(parseFleetInvitation(encoded), input);
});

test("Fleet invitation rejects malformed, expired and authority-bearing endpoints without echoing secrets", () => {
  const input = invitation();
  const encoded = encodeFleetInvitation(input);
  assert.throws(
    () => parseFleetInvitation(encoded, input.expiresAt),
    /expired/u,
  );
  assert.throws(
    () => encodeFleetInvitation({ ...input, expiresAt: Date.now() + 600_000 }),
    /expiry/u,
  );
  for (const endpoint of [
    "http://host.example",
    "https://user:password@host.example",
    "https://host.example/path",
    "https://host.example/?code=private",
    "https://host.example/#code",
    "https://host.example/..",
    "https://host.example:0",
    "https://host.example\\path",
  ]) {
    assert.throws(
      () => encodeFleetInvitation({ ...input, endpoint }),
      /endpoint/u,
    );
  }
  for (const changed of [
    { ...input, extra: "secret" },
    { ...input, version: 2 },
    { ...input, hostId: "" },
    { ...input, label: "a".repeat(121) },
    { ...input, code: "" },
    { ...input, access: "read", shellEnabled: true },
    { ...input, expiresAt: Number.NaN },
  ]) {
    assert.throws(() => encodeFleetInvitation(changed as FleetInvitation));
  }
  for (const text of [
    input.code,
    "zenx-fleet:v1:bad_base64",
    "zenx-fleet:v1:" + btoa('{"code":"do-not-echo-this-secret"}'),
    encoded + "=",
    "a".repeat(10_000),
  ]) {
    assert.throws(
      () => parseFleetInvitation(text),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.equal(error.message.includes(input.code), false);
        assert.equal(error.message.includes("do-not-echo-this-secret"), false);
        return true;
      },
    );
  }
});
