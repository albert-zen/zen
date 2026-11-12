import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { IM_CHANNEL_SDK_REVISION } from "../dist/channel-schema.js";

const source = new URL("../../../apps/imzen/", import.meta.url);
const staged = new URL("../python/", import.meta.url);

async function compare(relative) {
  const [original, generated] = await Promise.all([
    readFile(new URL(relative, source), "utf8"),
    readFile(new URL(relative, staged), "utf8"),
  ]);
  assert.equal(generated, original, `staged ${relative} must match IMZen`);
  return original;
}

test("generated plugin runtime uses the same exact SDK revision and source", async () => {
  const revision = IM_CHANNEL_SDK_REVISION;
  assert.match(revision, /^[a-f0-9]{40}$/);
  const project = await compare("pyproject.toml");
  const lock = await compare("uv.lock");
  const readiness = await compare("src/imzen/readiness.py");
  await compare("README.md");
  const pins = [...project.matchAll(/im-agent-sdk\.git@([a-z0-9]+)/g)];
  assert.equal(
    pins.length,
    2,
    "base and optional Feishu dependencies are pinned",
  );
  assert(pins.every((pin) => pin[1] === revision));
  assert(lock.includes(`?rev=${revision}#${revision}`));
  assert.equal([...lock.matchAll(/\?rev=([a-z0-9]+)/g)].length, 3);
  assert(
    [...lock.matchAll(/\?rev=([a-z0-9]+)/g)].every(
      (pin) => pin[1] === revision,
    ),
  );
  assert(readiness.includes(`SDK_REVISION = "${revision}"`));
  for (const entry of await readdir(new URL("src/imzen/", source))) {
    if (entry.endsWith(".py")) await compare(`src/imzen/${entry}`);
  }
});
