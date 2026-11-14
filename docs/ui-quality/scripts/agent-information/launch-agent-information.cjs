// QA-only native launcher. No model, renderer, DOM or App Server monkey patches.
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const checkOnly = process.argv[2] === "--check";
const repositoryArgument = checkOnly
  ? process.argv[3]
  : process.env.ZENX_AGENT_QA_REPOSITORY;
const rootArgument = checkOnly
  ? process.argv[4]
  : process.env.ZENX_AGENT_QA_ROOT;
if (!repositoryArgument || !rootArgument)
  throw Error("Explicit repository and isolated QA root required");
const repository = fs.realpathSync(repositoryArgument),
  qaRoot = fs.realpathSync(rootArgument);
const manifest = JSON.parse(
  fs.readFileSync(path.join(qaRoot, "seed-result.json"), "utf8"),
);
if (
  manifest.kind !== "zenx-native-agent-information-qa-v1" ||
  manifest.repository !== repository ||
  manifest.qaRoot !== qaRoot ||
  manifest.synthetic !== true
)
  throw Error("Root must match this successful isolated seed");
const profile = JSON.parse(
  fs.readFileSync(path.join(qaRoot, "profile", "host-profile.json"), "utf8"),
);
if (
  profile.version !== 3 ||
  !profile.providerProfiles?.length ||
  profile.providerProfiles.some((p) => p.type !== "fake")
)
  throw Error("Credential-free fake provider profiles required");
const catalog = JSON.parse(
  fs.readFileSync(
    path.join(qaRoot, "profile", "capability-grants.json"),
    "utf8",
  ),
);
if (
  catalog.disabled.includes("zenx-subagents") ||
  catalog.uninstalled.includes("zenx-subagents") ||
  !catalog.packages["zenx-subagents"]
)
  throw Error("Seeded native Subagents plugin is not enabled");
const main = path.join(repository, "apps/zenx/out/main/index.js");
for (const file of [
  main,
  path.join(repository, "apps/zenx/out/main/app-server-host.js"),
  path.join(repository, "apps/zenx/out/renderer/index.html"),
])
  if (!fs.statSync(file).isFile()) throw Error("Missing native build: " + file);
if (checkOnly) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        checkOnly: true,
        repository,
        qaRoot,
        fakeOnly: true,
        realSubagentsPluginInstalled: true,
        buildFilesPresent: true,
        hostStarted: false,
        modelOrRendererPatches: false,
      },
      null,
      2,
    ),
  );
} else {
  const { app, session } = require("electron");
  app.disableHardwareAcceleration(); // Matches existing cloud-desktop QA launch accommodation.
  app.setPath("userData", path.join(qaRoot, "profile"));
  app.setPath("sessionData", path.join(qaRoot, "profile"));
  app.setName("ZenX isolated Agent Information QA");
  process.env.ZENX_DATA_DIR = path.join(qaRoot, "data");
  process.env.ZENX_BROWSER_MODE = "isolated";
  process.env.npm_config_offline = "true";
  process.env.npm_config_cache = path.join(qaRoot, "npm-cache");
  process.env.npm_config_update_notifier = "false";
  for (const key of Object.keys(process.env))
    if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|SECRET)$/i.test(key))
      delete process.env[key];
  for (const key of [
    "ZENX_PLUGIN_DEV",
    "ZENX_USER_BROWSER_CDP_ENDPOINT",
    "ZENX_PROJECT_ACCEPTANCE_CONFIG",
    "ZENX_EXTERNAL_ZAS_ACCEPTANCE_CONFIG",
    "ZENX_PROVIDER",
    "ZENX_MODEL",
    "ZENX_MODELS",
    "ZENX_BASE_URL",
    "ZENX_SUBSCRIPTION_PROFILE",
    "ZENX_API_KEY_ENV",
    "NODE_OPTIONS",
    "ZENX_LIVE_QA_ROOT",
    "ZENX_LIVE_QA_REPOSITORY",
  ])
    delete process.env[key];
  app.whenReady().then(() =>
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const network = /^(?:https?|wss?):/i.test(details.url);
      let loopback = false;
      try {
        loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(
          new URL(details.url).hostname,
        );
      } catch {}
      callback({ cancel: network && !loopback });
    }),
  );
  console.log(
    JSON.stringify({
      qaRoot,
      repository,
      provider: "unmodified FakeModel",
      productionApp: true,
      modelOrRendererPatches: false,
    }),
  );
  import(pathToFileURL(main).href);
}
