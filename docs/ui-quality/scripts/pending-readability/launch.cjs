// Optional native QA launcher. Build/preparation does not execute this file.
process.env.TZ = "UTC";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const args = process.argv.slice(2);
const checkOnly = args[0] === "--check";
if (checkOnly) args.shift();
const [
  repositoryArgument,
  outputArgument,
  variant = "desktop",
  scenario = "pending",
  lang = "en",
  theme = "light",
] = args;
if (!repositoryArgument || !outputArgument)
  throw Error("Explicit repository and built QA output are required");
const repository = fs.realpathSync(repositoryArgument);
const output = fs.realpathSync(outputArgument);
const manifest = JSON.parse(
  fs.readFileSync(path.join(output, "manifest.json"), "utf8"),
);
if (
  manifest.kind !== "zenx-pending-readability-component-qa-v1" ||
  manifest.root !== repository
)
  throw Error(
    "Output does not match this repository's successful component build",
  );
for (const artifact of manifest.files) {
  const digest = createHash("sha256")
    .update(fs.readFileSync(path.join(output, artifact.path)))
    .digest("hex");
  if (digest !== artifact.sha256)
    throw Error(`Built artifact hash mismatch: ${artifact.path}`);
}
if (!["desktop", "narrow", "zoom200", "narrow-zoom200"].includes(variant))
  throw Error("Unknown viewport mode");
if (!["pending", "send", "footer", "manual"].includes(scenario))
  throw Error("Unknown scenario");
if (!["en", "zh-CN"].includes(lang) || !["light", "dark"].includes(theme))
  throw Error("Unknown language/theme");
if (checkOnly) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        checkOnly: true,
        repository,
        output,
        artifactsVerified: manifest.files.length,
        nativeStarted: false,
      },
      null,
      2,
    ),
  );
} else {
  const { app, BrowserWindow, session } = require("electron");
  const profile = path.join(output, `native-profile-${variant}-${scenario}`);
  fs.mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile);
  app.setPath("sessionData", profile);
  app.setName("ZenX pending/readability component QA");
  app.whenReady().then(async () => {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: /^(https?|wss?):/i.test(details.url) }),
    );
    const win = new BrowserWindow({
      width: 1188,
      height: 848,
      title: `Pending/readability: ${variant} / ${scenario} / ${lang} / ${theme}`,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    win.setMenuBarVisibility(false);
    win.on("page-title-updated", (event) => event.preventDefault());
    const zoom = variant.includes("zoom200") ? 2 : 1;
    const entry =
      variant === "narrow"
        ? "narrow.html"
        : variant === "narrow-zoom200"
          ? "narrow-zoom200.html"
          : "component.html";
    await win.loadFile(path.join(output, entry), {
      query: { scenario, lang, theme },
    });
    win.webContents.setZoomFactor(zoom);
    const observations = [];
    let previous = "";
    const timer = setInterval(async () => {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return;
      try {
        const rendered = await win.webContents.executeJavaScript(`(() => {
        const frame = document.querySelector("iframe");
        const target = frame ? frame.contentWindow : window;
        return { outerViewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, iframeViewport: frame ? { width: target.innerWidth, height: target.innerHeight } : null,
          ready: target.__pendingReadability?.ready ?? false, measurement: target.__pendingReadability?.measure() ?? null };
      })()`);
        const state = {
          variant,
          scenario,
          lang,
          theme,
          requestedOuterBounds: { width: 1188, height: 848 },
          actualOuterBounds: win.getBounds(),
          actualContentBounds: win.getContentBounds(),
          actualZoomFactor: win.webContents.getZoomFactor(),
          ...rendered,
        };
        const serialized = JSON.stringify(state);
        if (serialized !== previous) {
          previous = serialized;
          observations.push({ observedAt: new Date().toISOString(), ...state });
          fs.writeFileSync(
            path.join(
              output,
              `${variant}-${scenario}-${lang}-${theme}-native-measurements.json`,
            ),
            JSON.stringify(observations, null, 2) + "\n",
          );
        }
      } catch (error) {
        console.error("QA measurement unavailable:", error.message);
      }
    }, 500);
    win.on("closed", () => clearInterval(timer));
  });
  app.on("window-all-closed", () => app.quit());
}
