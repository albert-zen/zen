/** Synthetic helper transport only. No live KDE session or OS permission setup. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import {
  captureKdeActiveAppShot,
  getKdeAppShotSupport,
  isKdeSession,
  kdeAppShotPaths,
  type KdeAppShotImage,
  type KdeAppShotOptions,
} from "../src/main/app-shot-kde.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
  "base64",
);
const identity = {
  id: "{window-1}",
  title: "⠋ Document",
  appName: "Kate",
  appIdentifier: "org.kde.kate",
  processId: 123,
  bounds: { x: -100, y: 0, width: 800, height: 600 },
  clientBounds: { x: -100, y: 29, width: 800, height: 571 },
};
let root: string;
let dataHome: string;
let calls: string;
function image(width = 1, height = 1): KdeAppShotImage {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    resize: (size) => image(size.width, size.height),
    toPNG: () => png,
  };
}
function options(extra: Partial<KdeAppShotOptions> = {}): KdeAppShotOptions {
  return {
    dataHome,
    env: {
      ...process.env,
      XDG_CURRENT_DESKTOP: "KDE",
      FLATPAK_ID: "",
      SNAP: "",
      TEST_CALLS: calls,
    },
    createImage: () => image(),
    timeoutMs: 3000,
    ...extra,
  };
}
function desktop(executable: string): string {
  const quoted = executable
    .replaceAll("\\", () => "\\\\")
    .replaceAll("`", () => "\\`")
    .replaceAll("$", () => "\\$")
    .replaceAll('"', () => '\\"')
    .replaceAll("%", () => "%%");
  const exec = `"${quoted}"`.replaceAll("\\", "\\\\").replaceAll("\t", "\\t");
  return `[Desktop Entry]\nType=Application\nName=ZenX App Shot\nNoDisplay=true\nExec=${exec} check\nX-KDE-DBUS-Restricted-Interfaces=org.kde.KWin.ScreenShot2\nX-ZenX-Capture-Helper=true\n`;
}
async function installed(
  mode = "ok",
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const paths = kdeAppShotPaths({ dataHome });
  await fs.mkdir(dirname(paths.executable), { recursive: true, mode: 0o700 });
  await fs.mkdir(dirname(paths.desktop), { recursive: true, mode: 0o700 });
  const source = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const mode = ${JSON.stringify(mode)};
const override = ${JSON.stringify(overrides)};
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'check') {
  if (mode === 'denied') { process.stderr.write('org.kde.KWin.ScreenShot2.Error.NoAuthorized'); process.exit(1); }
  if (mode === 'old') { process.stdout.write(JSON.stringify({ready:true})); process.exit(0); }
  if (mode === 'oversized') { process.stdout.write('x'.repeat(140000)); process.exit(0); }
  process.stdout.write(JSON.stringify({protocolVersion:1,ready:true,feedbackAvailable:false,...override}));
} else if (args[0] === 'capture') {
  const output = path.join(args[1], 'capture.png');
  if (mode === 'hang') { setInterval(() => {}, 1000); }
  else {
    if (mode === 'symlink') fs.symlinkSync(process.env.TEST_CALLS, output);
    else {
      let bytes = Buffer.from(${JSON.stringify(png.toString("base64"))}, 'base64');
      if (mode === 'bad-png') bytes = Buffer.alloc(33);
      if (mode === 'huge-dimensions') { bytes.writeUInt32BE(100000,16); bytes.writeUInt32BE(100000,20); }
      fs.writeFileSync(output, bytes, {mode: mode === 'public' ? 0o644 : 0o600, flag:'wx'});
    }
    process.stdout.write(JSON.stringify({protocolVersion:1,window:mode === 'no-identity' ? null : ${JSON.stringify(identity)},...override}));
  }
} else { process.stderr.write('Unexpected operation'); process.exit(1); }
`;
  await fs.writeFile(paths.executable, source, { mode: 0o700 });
  await fs.writeFile(paths.desktop, desktop(paths.executable), { mode: 0o600 });
}
async function observedCalls(): Promise<string[][]> {
  try {
    return (await fs.readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
async function assertCaptureCleanup(): Promise<void> {
  const invocation = (await observedCalls()).find(
    (args) => args[0] === "capture",
  );
  assert.ok(invocation);
  await assert.rejects(fs.stat(invocation[1]!), { code: "ENOENT" });
}
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "zenx-kde-client-test-"));
  dataHome = join(root, "data");
  calls = join(root, "calls");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

it("recognizes KDE only and rejects sandbox sessions and relative helper roots", () => {
  assert.equal(isKdeSession({ XDG_CURRENT_DESKTOP: "Plasma:KDE" }), true);
  assert.equal(isKdeSession({ XDG_CURRENT_DESKTOP: "GNOME" }), false);
  assert.equal(
    isKdeSession({ XDG_CURRENT_DESKTOP: "KDE", SNAP: "yes" }),
    false,
  );
  assert.equal(
    isKdeSession({ XDG_CURRENT_DESKTOP: "KDE", FLATPAK_ID: "yes" }),
    false,
  );
  assert.throws(() => kdeAppShotPaths({ dataHome: "relative" }), /absolute/u);
});
it("missing helper reports manual setup without creating any files or launching anything", async () => {
  const support = await getKdeAppShotSupport(options());
  assert.equal(support.status, "manual-setup-required");
  assert.equal(support.available, false);
  await assert.rejects(fs.stat(dataHome), { code: "ENOENT" });
  assert.deepEqual(await observedCalls(), []);
});
it("non-KDE sessions never execute an installed helper", async () => {
  await installed();
  assert.equal(
    (
      await getKdeAppShotSupport(
        options({ env: { XDG_CURRENT_DESKTOP: "GNOME" } }),
      )
    ).status,
    "unavailable",
  );
  assert.deepEqual(await observedCalls(), []);
});
it("capability probe is check-only, versioned, and does not mutate the install", async () => {
  await installed();
  const paths = kdeAppShotPaths({ dataHome });
  const before = await fs.stat(paths.desktop);
  const support = await getKdeAppShotSupport(options());
  assert.equal(support.available, true);
  assert.equal(support.protocolVersion, 1);
  assert.equal(support.feedbackAvailable, false);
  assert.deepEqual(await observedCalls(), [["check"]]);
  assert.equal((await fs.stat(paths.desktop)).mtimeMs, before.mtimeMs);
});
it("refuses authorization denial without capture or repair", async () => {
  await installed("denied");
  await assert.rejects(
    captureKdeActiveAppShot(options()),
    /KDE denied capture access/u,
  );
  assert.deepEqual(await observedCalls(), [["check"]]);
});
it("rejects old helper protocol and oversized output", async () => {
  await installed("old");
  assert.match(
    (await getKdeAppShotSupport(options())).message,
    /protocol mismatch/u,
  );
  await installed("oversized");
  assert.match((await getKdeAppShotSupport(options())).message, /Oversized/u);
});
it("rejects unexpected capability fields and duplicate desktop keys", async () => {
  await installed("ok", { feedbackAvailable: true });
  assert.equal((await getKdeAppShotSupport(options())).available, false);
  const paths = kdeAppShotPaths({ dataHome });
  await fs.appendFile(paths.desktop, "Exec=anything\n");
  assert.match((await getKdeAppShotSupport(options())).message, /Duplicate/u);
  assert.deepEqual(await observedCalls(), [["check"]]);
});
it("rejects symlinks and unsafe helper modes before execution", async () => {
  await installed();
  const paths = kdeAppShotPaths({ dataHome });
  await fs.chmod(paths.executable, 0o777);
  assert.equal((await getKdeAppShotSupport(options())).available, false);
  await fs.chmod(paths.executable, 0o700);
  await fs.rename(paths.executable, paths.executable + ".real");
  await fs.symlink(paths.executable + ".real", paths.executable);
  assert.equal((await getKdeAppShotSupport(options())).available, false);
  assert.deepEqual(await observedCalls(), []);
});
it("validates desktop entry authority and fixed executable identity", async () => {
  await installed();
  const paths = kdeAppShotPaths({ dataHome });
  await fs.writeFile(
    paths.desktop,
    desktop(paths.executable).replace("org.kde.KWin.ScreenShot2", "other"),
  );
  assert.match(
    (await getKdeAppShotSupport(options())).message,
    /does not match/u,
  );
  assert.deepEqual(await observedCalls(), []);
});
it("captures exact helper identity, bounds private PNG, and cleans all scratch data", async () => {
  await installed();
  const capture = await captureKdeActiveAppShot(options());
  assert.deepEqual(capture, { png, width: 1, height: 1, window: identity });
  assert.deepEqual(
    (await observedCalls()).map((args) => args[0]),
    ["check", "capture"],
  );
  await assertCaptureCleanup();
});
it("null native identity stays pixels-only", async () => {
  await installed("no-identity");
  assert.deepEqual(await captureKdeActiveAppShot(options()), {
    png,
    width: 1,
    height: 1,
  });
  await assertCaptureCleanup();
});
it("rejects malformed identity and self-window captures and cleans files", async () => {
  await installed("ok", { window: { ...identity, processId: process.pid } });
  await assert.rejects(captureKdeActiveAppShot(options()), /own application/u);
  await assertCaptureCleanup();
  await fs.rm(calls);
  await installed("ok", {
    window: { ...identity, bounds: { ...identity.bounds, width: 0 } },
  });
  await assert.rejects(
    captureKdeActiveAppShot(options()),
    /Invalid KDE capture identity/u,
  );
  await assertCaptureCleanup();
});
it("rejects symlink/public/malformed and oversized-dimension screenshot files with cleanup", async () => {
  for (const mode of ["symlink", "public", "bad-png", "huge-dimensions"]) {
    await fs.rm(calls, { force: true });
    await installed(mode);
    await assert.rejects(captureKdeActiveAppShot(options()));
    await assertCaptureCleanup();
  }
});
it("aborted capture waits for helper exit and removes its private scratch directory", async () => {
  await installed("hang");
  const controller = new AbortController();
  const capture = captureKdeActiveAppShot(
    options({ signal: controller.signal }),
  );
  const observed = capture.catch((error: Error) => error);
  for (let i = 0; i < 100; i++) {
    if ((await observedCalls()).some((args) => args[0] === "capture")) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  controller.abort();
  assert.equal(((await observed) as Error).name, "AbortError");
  await assertCaptureCleanup();
});
it("pre-aborted probe never launches or creates files", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    getKdeAppShotSupport(options({ signal: controller.signal })),
    { name: "AbortError" },
  );
  assert.deepEqual(await observedCalls(), []);
});
it("hung capture is terminated within the bounded deadline and cleaned", async () => {
  await installed("hang");
  await assert.rejects(
    captureKdeActiveAppShot(options({ timeoutMs: 3_000 })),
    /timed out/u,
  );
  await assertCaptureCleanup();
});

it("validates Desktop Entry escaping for literal shell and field-code characters", async () => {
  dataHome = join(root, 'space \"quote $dollar `tick %percent \\backslash');
  await installed();
  assert.equal((await getKdeAppShotSupport(options())).available, true);
  assert.deepEqual(await observedCalls(), [["check"]]);
});
