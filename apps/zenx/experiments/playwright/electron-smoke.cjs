const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const evidence = process.env.ZENX_EXPERIMENT_EVIDENCE;
const { app, BrowserWindow, WebContentsView } = require("electron");
const { attachPlaywrightToWebContents } = require("./electron-target.cjs");

(async () => {
  await app.whenReady();
  if (evidence) await fs.mkdir(evidence, { recursive: true });
  const window = new BrowserWindow({
    width: 900,
    height: 700,
    show: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  let attachment;
  try {
    await window.loadURL(
      "data:text/html,<title>Unrelated host</title><p>Host shell must not be exposed</p>",
    );
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    window.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
    const html = `<!doctype html><title>Authorized fixture</title><input aria-label="Search" onkeydown="if(event.key==='Enter')document.body.dataset.submitted=this.value"><button onclick="document.body.dataset.clicked='yes'">Go</button><div id="shadow"></div><iframe title="Frame" srcdoc='<button onclick="document.body.dataset.clicked=1">Inside</button>'></iframe><script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>Shadow</button>';setTimeout(()=>{let b=document.createElement('button');b.textContent='Later';document.body.append(b)},600);</script>`;
    await view.webContents.loadURL(
      "data:text/html," + encodeURIComponent(html),
    );
    view.webContents.debugger.attach("1.3");
    attachment = await attachPlaywrightToWebContents(view.webContents, {
      exclusiveDebuggerLease: true,
    });
    const page = attachment.page;
    page.setDefaultTimeout(8000);
    assert.equal(await page.title(), "Authorized fixture");
    await page.getByRole("textbox", { name: "Search" }).fill("synthetic query");
    await page.getByRole("textbox", { name: "Search" }).press("Enter");
    assert.equal(
      await page.locator("body").getAttribute("data-submitted"),
      "synthetic query",
    );
    await page.getByRole("button", { name: "Go", exact: true }).click();
    assert.equal(
      await page.locator("body").getAttribute("data-clicked"),
      "yes",
    );
    await page.getByRole("button", { name: "Shadow", exact: true }).click();
    await page
      .frameLocator("iframe")
      .getByRole("button", { name: "Inside" })
      .click();
    assert.equal(
      await page
        .frameLocator("iframe")
        .locator("body")
        .getAttribute("data-clicked"),
      "1",
    );
    await page
      .getByRole("button", { name: "Later", exact: true })
      .click({ timeout: 5000 });
    const screenshot = await page.screenshot();
    assert.ok(screenshot.length > 100);
    if (evidence)
      await fs.writeFile(path.join(evidence, "synthetic-page.png"), screenshot);
    await attachment.close();
    attachment = undefined;
    assert.equal(view.webContents.isDestroyed(), false);
    assert.equal(view.webContents.debugger.isAttached(), true);
    assert.equal(window.webContents.getTitle(), "Unrelated host");
    const result = {
      status: "passed",
      engine: "Playwright Core 1.62.1",
      target: "Electron WebContentsView",
      scenarios: [
        "scoped target",
        "fill and Enter",
        "trusted click",
        "open shadow root",
        "iframe",
        "auto wait",
        "screenshot",
        "disconnect preserves page and debugger",
      ],
    };
    if (evidence)
      await fs.writeFile(
        path.join(evidence, "result.json"),
        JSON.stringify(
          {
            ...result,
            head: process.env.ZENX_EXPERIMENT_HEAD,
            electron: process.versions.electron,
            chromium: process.versions.chrome,
          },
          null,
          2,
        ),
      );
    console.log(JSON.stringify(result));
  } finally {
    await attachment?.close();
    window.destroy();
    app.quit();
  }
})().catch((error) => {
  console.error(
    String(error).replace(/ws:\/\/[^\s]+/g, "[local WebSocket endpoint]"),
  );
  app.exit(1);
});
