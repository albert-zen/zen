import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
const root = new URL("../native/hyprland-app-shot/", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");
function gitBlob(bytes) {
  return createHash("sha1")
    .update(`blob ${Buffer.byteLength(bytes)}\0`)
    .update(bytes)
    .digest("hex");
}

test("protocol XML and retained reference source match exact verified upstream blobs", async () => {
  const proof = JSON.parse(await read("upstream.json"));
  assert.equal(proof.revision, "337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17");
  assert.equal(proof.files.length, 12);
  for (const [local, upstream] of [
    [
      "protocols/hyprland-toplevel-export-v1.xml",
      "protocols/hyprland-toplevel-export-v1.xml",
    ],
    [
      "protocols/hyprland-toplevel-mapping-v1.xml",
      "protocols/hyprland-toplevel-mapping-v1.xml",
    ],
    ["upstream-reference/feedback.rs", "src/feedback.rs"],
    ["upstream-reference/ipc.rs", "src/ipc.rs"],
  ]) {
    assert.equal(
      gitBlob(await read(local)),
      proof.files.find(
        (file) => file.path === `native/hyprland-snap-shot/${upstream}`,
      ).sha,
    );
  }
});
test("distribution script keeps MIT and both separate BSD-3 notices alongside protocol XML", async () => {
  const mit = await read("LICENSE.t3code"),
    bsd = await read("LICENSE.hyprland-protocols");
  assert.match(mit, /Copyright \(c\) 2026 T3 Tools Inc\./);
  assert.match(mit, /Permission is hereby granted/);
  for (const [file, holder] of [
    ["hyprland-toplevel-export-v1.xml", "2022 Vaxry"],
    ["hyprland-toplevel-mapping-v1.xml", "2025 WhySoBad"],
  ]) {
    assert.match(bsd, new RegExp(holder));
    assert.match(await read(`protocols/${file}`), new RegExp(holder));
  }
  assert.equal(bsd.match(/THIS SOFTWARE IS PROVIDED/g)?.length, 2);
  const build = await readFile(
    new URL("../scripts/build-app-shot-hyprland.mjs", import.meta.url),
    "utf8",
  );
  for (const file of [
    "LICENSE.t3code",
    "LICENSE.hyprland-protocols",
    "hyprland-toplevel-export-v1.xml",
    "hyprland-toplevel-mapping-v1.xml",
  ])
    assert.ok(build.includes(file));
  assert.ok(build.includes('"--locked"'));
  assert.ok(build.includes('"--release"'));
});
test("native production commands do not expose upstream focus, overlay or shortcut authority", async () => {
  const main = await read("src/main.rs"),
    ipc = await read("src/ipc.rs");
  assert.doesNotMatch(
    main,
    /mod feedback;|Some\("activate"\)|Some\("feedback"\)/,
  );
  assert.doesNotMatch(ipc, /\/dispatch|Command::|hyprctl|grim/);
  const cargo = await read("Cargo.toml");
  assert.match(cargo, /edition = "2024"/);
  assert.match(
    cargo,
    /smithay-client-toolkit = \{ version = "0.19.2", default-features = false \}/,
  );
});
