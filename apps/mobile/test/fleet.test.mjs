import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deviceStatus,
  hostEndpoint,
  makeHost,
  readSavedHosts,
  reconnectAvailable,
  saveHosts,
} from "../src/fleet.mjs";

test("Fleet origins reject credentials, queries, paths, plaintext and ambiguous whitespace", () => {
  for (const endpoint of [
    "http://host",
    "https://user:secret@host",
    "https://host/?token=secret",
    "https://host/#secret",
    "https://host/path",
    "https://host /",
    "garbage",
  ])
    assert.throws(() => hostEndpoint(endpoint));
  assert.equal(hostEndpoint(" https://host:4321/ "), "https://host:4321/");
  assert.equal(hostEndpoint("https://[::1]:4321"), "https://[::1]:4321");
});

test("Fleet migration preserves origins and custom names, filters invalid/duplicate/reserved identities", () => {
  const saved = JSON.stringify([
    { id: "fixture-desktop", endpoint: "https://wrong-host" },
    { id: "host-desktop", endpoint: "https://desktop/" },
    { id: "host-desktop", endpoint: "https://other" },
    { id: "host-laptop", endpoint: "https://laptop", name: "My laptop" },
    { id: "host-secret", endpoint: "https://secret@host" },
    { id: "bad_id!!!", endpoint: "https://host" },
  ]);
  const hosts = readSavedHosts(saved, ["fixture-desktop"]);
  assert.deepEqual(hosts, [
    { id: "host-desktop", endpoint: "https://desktop/", name: "host-desktop" },
    { id: "host-laptop", endpoint: "https://laptop", name: "My laptop" },
  ]);
  assert.deepEqual(readSavedHosts(saveHosts(hosts)), hosts);
  assert.throws(() => readSavedHosts("{}"));
  assert.throws(() =>
    makeHost({
      id: "host-12345",
      endpoint: "https://host",
      name: "x".repeat(81),
    }),
  );
});

test("Fleet never labels an unselected paired device connected or asserts a remote offline state", () => {
  assert.equal(
    deviceStatus({
      fixture: false,
      selected: false,
      connection: "connected",
      pairing: "paired",
    }),
    "Paired · disconnected",
  );
  assert.equal(
    deviceStatus({
      fixture: false,
      selected: true,
      connection: "offline",
      pairing: "unpaired",
    }),
    "Not paired",
  );
  assert.equal(
    deviceStatus({
      fixture: false,
      selected: true,
      connection: "offline",
      pairing: "revoked",
    }),
    "Pairing revoked · pair again",
  );
  assert.equal(
    deviceStatus({
      fixture: false,
      selected: true,
      connection: "connected",
      pairing: "paired",
    }),
    "Connected · verified Host",
  );
});

test("actual App reconnect eligibility covers offline and uncertain Thread/Room delivery", () => {
  for (const connection of ["offline", "connected"])
    assert.equal(
      reconnectAvailable({
        host: "host-a",
        connection,
        command: "uncertain",
        pairing: "paired",
      }),
      true,
    );
  assert.equal(
    reconnectAvailable({
      host: "host-a",
      connection: "offline",
      command: null,
      pairing: "paired",
    }),
    true,
  );
  assert.equal(
    reconnectAvailable({
      host: "host-a",
      connection: "connected",
      command: null,
      pairing: "paired",
    }),
    false,
  );
  for (const pairing of ["unpaired", "revoked", "invalid", undefined])
    assert.equal(
      reconnectAvailable({
        host: "host-a",
        connection: "offline",
        command: "uncertain",
        pairing,
      }),
      false,
    );
  assert.equal(
    reconnectAvailable({
      host: null,
      connection: "offline",
      command: "uncertain",
      pairing: "paired",
    }),
    false,
  );
});
