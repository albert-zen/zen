import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { parse } from "yaml";
const read = (name) =>
  readFile(new URL(`../scripts/${name}`, import.meta.url), "utf8");
test("native preload exposes only the bounded fixture mount channel", async () => {
  let exposed;
  const calls = [];
  vm.runInNewContext(await read("fullscreen-primary-native-preload.cjs"), {
    require(name) {
      assert.equal(name, "electron");
      return {
        contextBridge: {
          exposeInMainWorld(name, api) {
            assert.equal(name, "__nativeFullscreenBridge");
            exposed = api;
          },
        },
        ipcRenderer: {
          invoke(...args) {
            calls.push(args);
            return Promise.resolve();
          },
        },
      };
    },
  });
  assert.deepEqual(Object.keys(exposed), ["mount"]);
  const request = { threadId: "thread-a", lease: "exact-lease" };
  await exposed.mount(request);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "fixture:fullscreen-mount");
  assert.equal(calls[0][1], request);
});
test("native acceptance keeps production mounting, exact leases and explicit scope", async () => {
  const source = await read("capture-fullscreen-primary-native.ts");
  assert.match(source, /createElectronWorkspaceBrowser/);
  assert.match(source, /process\.platform, "darwin"/);
  assert.match(source, /process\.env\.GITHUB_ACTIONS/);
  assert.match(source, /event\.senderFrame, event\.sender\.mainFrame/);
  assert.match(source, /browser!\.mount\(event\.sender/);
  assert.match(source, /report\.mounts\.at\(-1\)\.lease, lease/);
  assert.match(source, /sendInputEvent/);
  assert.match(source, /background streamed content/);
  assert.match(source, /hidden resize retains reading row/);
  assert.match(
    source,
    /targeted parent wheel leaves detached native page unchanged/,
  );
  assert.match(source, /not a fabricated composited screenshot/);
  assert.doesNotMatch(
    source,
    /desktopCapturer|--no-sandbox|setPermissionCheckHandler|rerun/,
  );
});
test("hosted native acceptance is independent and does not replace Chromium coverage", async () => {
  const source = await readFile(
    new URL(
      "../../../.github/workflows/fullscreen-primary-chat-ui.yml",
      import.meta.url,
    ),
    "utf8",
  );
  const workflow = parse(source);
  assert.equal(
    workflow.jobs["chromium-synthetic-layout"]["runs-on"],
    "ubuntu-24.04",
  );
  const job = workflow.jobs["native-macos-fullscreen"];
  assert.equal(job["runs-on"], "macos-latest");
  assert.equal(job["continue-on-error"], undefined);
  assert.ok(
    job.steps.some((s) =>
      s.run?.includes(
        "npx --no-install electron .fullscreen-primary-native/native-main.cjs",
      ),
    ),
  );
  assert.ok(
    job.steps.some(
      (s) => s.if === "always()" && s.uses === "actions/upload-artifact@v4",
    ),
  );
});
