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
  inputBoundary:
    "Electron sendInputEvent with trusted DOM acknowledgement; synthetic components, no production Host or OS hit-test",
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
let clickId = 0;
async function click(selector) {
  const sequence = ++clickId;
  const target = JSON.stringify(selector);
  const point = await evaluate(
    `(()=>{const e=document.querySelector(${target});if(!e)throw Error('Missing target');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2);if(e.disabled||!e.contains(document.elementFromPoint(x,y)))throw Error('Obscured target: '+${target});e.addEventListener('click',event=>{if(event.isTrusted)window.__shelfClick=${sequence}},{once:true,capture:true});return {x,y}})()`,
  );
  window.focus();
  window.webContents.focus();
  window.webContents.sendInputEvent({
    type: "mouseDown",
    button: "left",
    clickCount: 1,
    ...point,
  });
  window.webContents.sendInputEvent({
    type: "mouseUp",
    button: "left",
    clickCount: 1,
    ...point,
  });
  await until(`window.__shelfClick===${sequence}`);
}
async function screenshot(name) {
  await fs.writeFile(
    path.join(directory, name + ".png"),
    (await window.webContents.capturePage()).toPNG(),
  );
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
    for (const [name, width, height, theme, lang] of [
      ["steer-wide-light", 1440, 900, "light", "zh"],
      ["steer-wide-dark", 1440, 900, "dark", "zh"],
      ["steer-narrow", 390, 600, "light", "zh"],
      ["steer-narrow-english", 390, 600, "dark", "en"],
    ]) {
      window.setContentSize(width, height);
      await window.loadFile(path.join(temporary, "queue-steer-visual.html"), {
        query: { lang, theme, ...(width === 390 ? { narrow: "1" } : {}) },
      });
      await until("Boolean(document.querySelector('.steer-shelf'))");
      await pause(150);
      const geometry = await evaluate(
        "(()=>{const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};return {viewport:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,shelf:rect('.steer-shelf'),composer:rect('.composer'),inBottomZone:!!document.querySelector('.steer-shelf').closest('.bottom-zone'),inTranscript:!!document.querySelector('.steer-shelf').closest('.messages'),recall:document.querySelector('.pending-steer-heading .queue-header-action').textContent,rows:document.querySelectorAll('.steer-shelf-row').length}})()",
      );
      assert.equal(geometry.overflow, false);
      assert.equal(geometry.inBottomZone, true);
      assert.equal(geometry.inTranscript, false);
      assert.equal(geometry.recall, lang === "zh" ? "全部撤回" : "Recall all");
      assert.equal(
        await evaluate("document.querySelector('.steer-shelf-details').hidden"),
        false,
      );
      assert.equal(
        await evaluate(
          "Boolean(document.querySelector('.pending-steer-heading .queue-header-action svg'))",
        ),
        true,
      );
      assert.equal(
        await evaluate(
          "document.querySelector('.message-source-link').getAttribute('aria-disabled')",
        ),
        "false",
      );
      assert.equal(
        await evaluate(
          "Boolean(document.querySelector('.message-source-status'))",
        ),
        false,
      );
      const countLabels = await evaluate(
        "Array.from(document.querySelectorAll('.queue-shelf-header [role=status]'),e=>e.textContent)",
      );
      assert.deepEqual(
        countLabels,
        lang === "zh"
          ? ["等待当前轮次结束 · 1 条", "等待进入模型 · 2 条"]
          : [
              "After this turn · 1 message",
              "Waiting for the model · 2 messages",
            ],
      );
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
      result.cases.push({ name, geometry, countLabels });
      await click(".pending-steer-heading .queue-shelf-toggle");
      await until("document.querySelector('.steer-shelf-details').hidden");
      await click(".pending-steer-heading .queue-shelf-toggle");
      await until("!document.querySelector('.steer-shelf-details').hidden");
      if (name === "steer-wide-light") {
        await click(".message-source-link");
        await until(
          "Boolean(document.querySelector('.thread-row-shell[data-thread-id=\"synthetic-planner\"] .thread-row[aria-current=page]'))",
        );
        assert.equal(
          await evaluate(
            "document.querySelector('.agent-surface').textContent.includes('普通线程消息仍默认 soft steer')",
          ),
          true,
        );
        await screenshot("queue-source-opened");
        result.cases.push({
          name: "queue-source-opened",
          boundary:
            "Synthetic navigator checks exact canonical sender ID and opens its existing fixture Thread; not Host navigation E2E",
        });
      }
    }
    window.setContentSize(390, 600);
    await window.loadFile(path.join(temporary, "queue-steer-visual.html"), {
      query: { lang: "zh", theme: "light", narrow: "1", many: "1" },
    });
    await until("Boolean(document.querySelector('.queue-row-edit'))");
    await screenshot("queue-human-edit-entry");
    await click(".queue-row-edit");
    await until("Boolean(document.querySelector('[role=dialog]'))");
    await screenshot("queue-human-edit-open");
    result.cases.push({
      name: "queue-human-edit",
      boundary:
        "Production Queue editor over synthetic human input; native save is stubbed",
    });
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
