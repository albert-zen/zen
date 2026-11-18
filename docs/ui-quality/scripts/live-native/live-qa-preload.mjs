// Only injected into the isolated App Server child by launch-live-native.cjs.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { installLiveQa } from "./live-qa-controls.mjs";
const root = process.env.ZENX_LIVE_QA_ROOT;
if (!root || path.resolve(root) !== root)
  throw Error("Explicit absolute QA root required");
const manifest = JSON.parse(
  await fs.readFile(path.join(root, "seed-result.json"), "utf8"),
);
if (
  manifest.kind !== "zenx-live-native-qa-v1" ||
  manifest.qaRoot !== root ||
  manifest.synthetic !== true ||
  process.env.ZENX_LIVE_QA_REPOSITORY !== manifest.repository ||
  process.env.ZENX_DATA_DIR !== path.join(root, "data")
)
  throw Error("Not an isolated live QA profile");
const profile = JSON.parse(
  await fs.readFile(path.join(root, "profile", "host-profile.json"), "utf8"),
);
if (
  !Array.isArray(profile.providerProfiles) ||
  !profile.providerProfiles.length ||
  profile.providerProfiles.some((provider) => provider.type !== "fake")
)
  throw Error("Only fake providers are allowed");
const chunksDirectory = path.join(
  manifest.repository,
  "apps/zenx/out/main/chunks",
);
const candidates = (await fs.readdir(chunksDirectory)).filter((name) =>
  /^app-server-.*\.js$/.test(name),
);
if (candidates.length !== 1)
  throw Error("Build must have exactly one App Server chunk");
const bundle = await import(
  pathToFileURL(path.join(chunksDirectory, candidates[0])).href
);
const named = (name) => {
  const matches = Object.values(bundle).filter(
    (value) => typeof value === "function" && value.name === name,
  );
  if (matches.length !== 1)
    throw Error(`Expected exactly one exported ${name}`);
  return matches[0];
};
installLiveQa({
  FakeModel: named("FakeModel"),
  ZenAppServer: named("ZenAppServer"),
  AppServerError: named("AppServerError"),
  receiptPath: path.join(root, "live-controls.jsonl"),
});
console.error(
  "[local QA] Controlled FakeModel timing enabled for isolated native host only",
);
