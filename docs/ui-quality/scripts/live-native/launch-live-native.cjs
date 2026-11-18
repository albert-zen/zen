// QA-only launcher. --check is read-only and does not load Electron or start a host.
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const { pathToFileURL } = require("node:url");
const checkOnly = process.argv[2] === "--check";
const repositoryArgument = checkOnly
  ? process.argv[3]
  : process.env.ZENX_LIVE_QA_REPOSITORY;
const rootArgument = checkOnly
  ? process.argv[4]
  : process.env.ZENX_LIVE_QA_ROOT;
if (!repositoryArgument || !rootArgument)
  throw Error("Explicit repository and isolated QA root are required");
const repository = fs.realpathSync(path.resolve(repositoryArgument));
const qaRoot = fs.realpathSync(path.resolve(rootArgument));
const manifest = JSON.parse(
  fs.readFileSync(path.join(qaRoot, "seed-result.json"), "utf8"),
);
if (
  manifest.kind !== "zenx-live-native-qa-v1" ||
  manifest.qaRoot !== qaRoot ||
  manifest.repository !== repository ||
  manifest.synthetic !== true
)
  throw Error(
    "Repository/root must match the successful isolated QA seed; seed a fresh root for a different checkout",
  );
const profile = JSON.parse(
  fs.readFileSync(path.join(qaRoot, "profile", "host-profile.json"), "utf8"),
);
if (
  profile.version !== 3 ||
  !Array.isArray(profile.providerProfiles) ||
  profile.providerProfiles.length === 0 ||
  profile.providerProfiles.some((provider) => provider.type !== "fake")
)
  throw Error("Only credential-free fake provider profiles are allowed");
const hostEntry = path.join(
  repository,
  "apps/zenx/out/main/app-server-host.js",
);
const mainEntry = path.join(repository, "apps/zenx/out/main/index.js");
const preloadFile = path.join(__dirname, "live-qa-preload.mjs");
for (const file of [
  hostEntry,
  mainEntry,
  preloadFile,
  path.join(__dirname, "live-qa-controls.mjs"),
  path.join(repository, "apps/zenx/out/renderer/index.html"),
])
  if (!fs.statSync(file).isFile())
    throw Error(`Missing required build/fixture file: ${file}`);
const chunksDirectory = path.join(repository, "apps/zenx/out/main/chunks");
const candidates = fs
  .readdirSync(chunksDirectory)
  .filter((name) => /^app-server-.*\.js$/.test(name));
if (candidates.length !== 1)
  throw Error("Build must have exactly one App Server chunk");
if (checkOnly) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        checkOnly: true,
        repository,
        qaRoot,
        fakeOnly: true,
        isolatedMarker: true,
        referencedFilesPresent: true,
        appServerChunk: candidates[0],
        hostStarted: false,
      },
      null,
      2,
    ),
  );
} else {
  const { app, session } = require("electron");
  app.disableHardwareAcceleration(); // QA-only workaround used by the recorded cloud-desktop captures.
  app.setPath("userData", path.join(qaRoot, "profile"));
  app.setPath("sessionData", path.join(qaRoot, "profile"));
  app.setName("ZenX isolated live UI QA");
  process.env.ZENX_LIVE_QA_ROOT = qaRoot;
  process.env.ZENX_LIVE_QA_REPOSITORY = repository;
  process.env.ZENX_DATA_DIR = path.join(qaRoot, "data");
  process.env.ZENX_BROWSER_MODE = "isolated";
  process.env.npm_config_cache = path.join(qaRoot, "npm-cache");
  process.env.npm_config_update_notifier = "false";
  for (const key of Object.keys(process.env)) {
    if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|SECRET)$/i.test(key))
      delete process.env[key];
  }
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
  ])
    delete process.env[key];
  const preload = pathToFileURL(preloadFile).href;
  const originalFork = childProcess.fork;
  childProcess.fork = function (modulePath, args, options) {
    if (path.resolve(String(modulePath)) === hostEntry) {
      options = {
        ...options,
        execArgv: [...(options?.execArgv || []), "--import", preload],
      };
      console.log(
        "[local QA] Timing fixture injected into isolated host child",
      );
    }
    return originalFork.call(this, modulePath, args, options);
  };
  syncBuiltinESMExports();
  app.whenReady().then(() => {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const isNetwork = /^(?:https?|wss?):/i.test(details.url);
      let isLoopback = false;
      try {
        isLoopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(
          new URL(details.url).hostname,
        );
      } catch {}
      callback({ cancel: isNetwork && !isLoopback });
    });
  });
  console.log(
    JSON.stringify({
      qaRoot,
      repository,
      source: "QA-only runtime preload; unchanged production app",
      provider: "fake",
    }),
  );
  import(pathToFileURL(mainEntry).href);
}
