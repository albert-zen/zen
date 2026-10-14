import assert from "node:assert/strict";
import path from "node:path";
import { app, type WebContentsView } from "electron";

import { createElectronWorkspaceBrowser } from "./workspace-browser-electron.js";

// Launched only by the coordinator with a newly owned, synthetic profile.
const profile = process.env.ZENX_BROWSER_PERSISTENCE_PROFILE;
const origin = process.env.ZENX_BROWSER_PERSISTENCE_ORIGIN;
const phase = process.env.ZENX_BROWSER_PERSISTENCE_PHASE;
assert.ok(profile && origin && (phase === "write" || phase === "read"));
assert.equal(app.commandLine.getSwitchValue("user-data-dir"), profile);
app.on("window-all-closed", () => undefined);

void app.whenReady().then(async () => {
  const views: WebContentsView[] = [];
  const browser = createElectronWorkspaceBrowser({
    artifactDirectory: path.join(profile, "fixture-artifacts"),
    onCreateView: (view) => views.push(view),
  });
  try {
    assert.equal(app.getPath("userData"), profile);
    assert.equal(app.getPath("sessionData"), profile);
    browser.bindThreadSession("fixture-session", "fixture-thread");
    assert.deepEqual(await browser.listTabs("fixture-session"), []);
    const tab = await browser.open(
      "fixture-session",
      `${origin}/${phase === "write" ? "login" : "inspect"}`,
    );
    const view = views[0]!;
    const session = view.webContents.session;
    assert.ok(session.isPersistent());
    assert.equal(
      session.storagePath,
      path.join(profile, "Partitions", "zenx-workspace-browser"),
    );
    const state = () =>
      view.webContents.executeJavaScript(`({
        persistentCookie: document.cookie.includes('fixture_persistent=present'),
        sessionCookie: document.cookie.includes('fixture_session=present'),
        localStorage: localStorage.getItem('fixture-local'),
        sessionStorage: sessionStorage.getItem('fixture-tab')
      })`);
    if (phase === "write") {
      assert.deepEqual(await state(), {
        persistentCookie: true,
        sessionCookie: true,
        localStorage: "present",
        sessionStorage: "present",
      });
      // Thread-session detachment must not delete the app-owned page/profile.
      assert.equal(browser.closeSession("fixture-session"), 0);
      browser.bindThreadSession("fixture-session", "fixture-thread");
      assert.equal(
        (await browser.listTabs("fixture-session"))[0]?.tabId,
        tab.tabId,
      );
      assert.equal((await state()).sessionStorage, "present");
      await browser.open("fixture-session", `${origin}/inspect`);
      const second = views[1]!;
      assert.equal(second.webContents.session, session);
      assert.deepEqual(
        await second.webContents.executeJavaScript(`({
          persistentCookie: document.cookie.includes('fixture_persistent=present'),
          sessionCookie: document.cookie.includes('fixture_session=present'),
          localStorage: localStorage.getItem('fixture-local'),
          sessionStorage: sessionStorage.getItem('fixture-tab')
        })`),
        {
          persistentCookie: true,
          sessionCookie: true,
          localStorage: "present",
          sessionStorage: null,
        },
      );
      await browser.closeTab("fixture-session", tab.tabId);
      assert.equal(second.webContents.isDestroyed(), false);
      assert.equal(
        await second.webContents.executeJavaScript(
          "document.cookie.includes('fixture_persistent=present')",
        ),
        true,
      );
    } else {
      assert.deepEqual(await state(), {
        persistentCookie: true,
        sessionCookie: false,
        localStorage: "present",
        sessionStorage: null,
      });
    }
    console.log(
      `ZENX_BROWSER_PERSISTENCE_RESULT ${JSON.stringify({
        phase,
        pid: process.pid,
        electron: process.versions.electron,
        userData: app.getPath("userData"),
        storagePath: session.storagePath,
        passed: true,
      })}`,
    );
    // No forced cookie expiry, serialization, restore, or explicit flush: use
    // ordinary graceful Electron shutdown, as a real app restart would.
    await browser.shutdown();
    app.quit();
  } catch (error) {
    console.error(error);
    await browser.shutdown().catch(() => undefined);
    app.exit(1);
  }
});
