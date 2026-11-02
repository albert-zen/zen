import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { withPreviewBrowser, delay } from "./preview-browser.mjs";

const directory = path.resolve(
  process.argv[2] ?? ".canonical-input-title-preview",
);
const observations = [];
await withPreviewBrowser(
  directory,
  async ({ send, evaluate, url, screenshot }) => {
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1100,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const theme of ["light", "dark"]) {
      const destination = `${url}/naming.html?theme=${theme}`;
      await send("Page.navigate", { url: destination });
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        ready = await evaluate(
          `location.href===${JSON.stringify(destination)} && document.querySelectorAll('.thread-row').length>=6`,
        );
        if (ready) break;
        await delay(50);
      }
      assert(ready, "Production Sidebar rows rendered");
      const labels = await evaluate(
        "[...document.querySelectorAll('.thread-row')].map(e=>e.textContent)",
      );
      for (const expected of [
        "User input",
        "Thread input",
        "Host input",
        "Release plan review",
        "Weekly summary",
        "My saved title stays unchanged",
      ])
        assert(
          labels.some((label) => label.includes(expected)),
          expected,
        );
      const appearance = await evaluate(`({
        selected: document.documentElement.dataset.appearance,
        colorScheme: getComputedStyle(document.documentElement).colorScheme,
        canvas: getComputedStyle(document.documentElement).getPropertyValue('--color-canvas').trim(),
      })`);
      assert.equal(appearance.selected, theme);
      assert.equal(
        appearance.colorScheme,
        theme,
        "Production appearance CSS applied",
      );
      observations.push({ theme, labels, appearance });
      await screenshot(`canonical-first-input-${theme}.png`);
    }
  },
);
assert.notEqual(
  observations[0].appearance.canvas,
  observations[1].appearance.canvas,
  "Light and dark production canvas colors differ",
);
await writeFile(
  path.join(directory, "observations.json"),
  JSON.stringify(
    {
      scope:
        "Actual production Sidebar with wholly synthetic canonical inputs and seeded generated/manual titles; component visual verification, not full App or title inference E2E.",
      observations,
    },
    null,
    2,
  ) + "\n",
);
