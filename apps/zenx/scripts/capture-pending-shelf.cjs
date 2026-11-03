const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { app, BrowserWindow, session } = require("electron");
assert.equal(process.env.GITHUB_ACTIONS, "true");
const [directory, temporary] = process.argv.slice(2, 4);
app.setPath("userData", path.join(temporary, "profile"));
const result = {
  ok: false,
  synthetic: true,
  platform: process.platform,
  cases: [],
};
let window;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (expression) =>
  window.webContents.executeJavaScript(expression);
async function until(expression) {
  for (let n = 0; n < 100; n++) {
    if (await evaluate(expression)) return;
    await pause(50);
  }
  throw Error("Timed out: " + expression);
}
app
  .whenReady()
  .then(async () => {
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*"] },
      (_details, done) => done({ cancel: true }),
    );
    window = new BrowserWindow({
      width: 1440,
      height: 1000,
      show: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    for (const [name, width, theme] of [
      ["steer-wide-light", 1440, "light"],
      ["steer-wide-dark", 1440, "dark"],
      ["steer-narrow", 390, "light"],
    ]) {
      window.setContentSize(width, 900);
      await window.loadFile(path.join(temporary, "queue-steer-visual.html"), {
        query: { lang: "zh", theme, ...(width === 390 ? { narrow: "1" } : {}) },
      });
      await until("Boolean(document.querySelector('.steer-shelf'))");
      await evaluate(
        "document.querySelector('.steer-shelf-details > summary').click()",
      );
      await pause(150);
      const geometry = await evaluate(
        "(()=>{const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};return {viewport:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,shelf:rect('.steer-shelf'),composer:rect('.composer'),inBottomZone:!!document.querySelector('.steer-shelf').closest('.bottom-zone'),inTranscript:!!document.querySelector('.steer-shelf').closest('.messages'),recall:document.querySelector('.pending-steer-heading button').textContent,rows:document.querySelectorAll('.steer-shelf-row').length}})()",
      );
      assert.equal(geometry.overflow, false);
      assert.equal(geometry.inBottomZone, true);
      assert.equal(geometry.inTranscript, false);
      assert.equal(geometry.recall, "全部撤回");
      assert.equal(geometry.rows, 2);
      assert.ok(
        geometry.shelf.bottom <= geometry.composer.y + 2,
        "Steer is above the input",
      );
      assert.ok(
        geometry.shelf.x >= 0 && geometry.shelf.right <= geometry.viewport,
      );
      await fs.writeFile(
        path.join(directory, name + ".png"),
        (await window.webContents.capturePage()).toPNG(),
      );
      result.cases.push({ name, geometry });
    }
    window.setContentSize(800, 500);
    await window.loadFile(path.join(temporary, "pending-send-visual.html"));
    await until(
      "Boolean(document.querySelector('.pending-send-row .user-bubble'))",
    );
    const bubbles = await evaluate(
      "(()=>{const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {width:r.width,height:r.height}};return {pending:rect('.pending-send-row .user-bubble'),settled:rect('[data-settled] .user-bubble')}})()",
    );
    assert.deepEqual(
      bubbles.pending,
      bubbles.settled,
      "Local sending and settled bubble geometry match",
    );
    await fs.writeFile(
      path.join(directory, "pending-settled.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
    result.cases.push({ name: "pending-settled", bubbles });
    result.ok = true;
  })
  .catch(async (error) => {
    result.error = String(error.stack || error);
    console.error(result.error);
    if (window && !window.isDestroyed())
      await fs.writeFile(
        path.join(directory, "failure.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
  })
  .finally(async () => {
    await fs.writeFile(
      path.join(directory, "acceptance.json"),
      JSON.stringify(result, null, 2),
    );
    app.exit(result.ok ? 0 : 1);
  });
