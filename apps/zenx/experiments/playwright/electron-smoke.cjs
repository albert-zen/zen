const assert = require("node:assert/strict");
const { app, BrowserWindow, WebContentsView } = require("electron");
const { attachPlaywrightToWebContents } = require("./electron-target.cjs");

(async () => {
  await app.whenReady();
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
    assert.ok((await page.screenshot()).length > 100);
    await attachment.close();
    attachment = undefined;
    assert.equal(view.webContents.isDestroyed(), false);
    assert.equal(view.webContents.debugger.isAttached(), true);
    assert.equal(window.webContents.getTitle(), "Unrelated host");
    console.log(
      JSON.stringify({
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
      }),
    );
  } finally {
    await attachment?.close();
    window.destroy();
    app.quit();
  }
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
