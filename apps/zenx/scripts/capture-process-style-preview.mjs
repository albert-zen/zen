import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { withPreviewBrowser, delay } from "./preview-browser.mjs";
const directory = path.resolve(process.argv[2] ?? ".process-style-preview");
const previewScenes = [
  "thinking",
  "thinking-short",
  "thinking-empty",
  "command-long",
  "command-short",
];
const matrix = [
  ...["light", "dark"].map((theme) => ({
    scene: "wait-lifecycle",
    theme,
    width: 1280,
    height: 900,
    lang: "en",
  })),
  ...previewScenes.flatMap((scene) =>
    [
      { theme: "light", width: 1280, lang: "zh-CN" },
      { theme: "dark", width: 1280, lang: "en" },
      { theme: "light", width: 420, lang: "en" },
      { theme: "dark", width: 420, lang: "zh-CN" },
    ].map((appearance) => ({ scene, ...appearance, height: 900 })),
  ),
  { scene: "waiting", theme: "dark", width: 1280, height: 900, lang: "zh-CN" },
  { scene: "waiting", theme: "light", width: 420, height: 900, lang: "zh-CN" },
  ...["running", "approval", "stopping", "recovery"].map((scene) => ({
    scene,
    theme: "light",
    width: 1280,
    height: 900,
    lang: "zh-CN",
  })),
  ...["running", "waiting", "approval", "stopping", "recovery"].map(
    (scene) => ({ scene, theme: "dark", width: 1280, height: 900, lang: "en" }),
  ),
];
const measure = `(() => {
  const turn = document.querySelector('.turn');
  const header = turn?.querySelector(':scope > .turn-running-label, :scope > .turn-toggle');
  const history = turn?.querySelector(':scope > .turn-history');
  const messages = turn?.closest('.messages');
  const row = history?.querySelector('.trace-toggle, .trace-item-toggle, .trace-item-static');
  const rect = element => element ? { x: element.getBoundingClientRect().x, y: element.getBoundingClientRect().y, width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height } : null;
  const activity = element => {
    const content = element.querySelector(':scope > .activity-content');
    const label = content?.querySelector('.activity-label');
    const prefix = content?.querySelector('strong');
    const icon = content?.querySelector('.trace-tool-icons, svg');
    const sweep = element.querySelector('.activity-sweep');
    const style = sweep && getComputedStyle(sweep);
    const copyContent = sweep?.querySelector('.activity-content');
    const copyLabel = copyContent?.querySelector('.activity-label');
    const labelStyle = label && getComputedStyle(label);
    const animations = sweep?.getAnimations() ?? [];
    return { rect: rect(element), content: rect(content), copyContent: rect(copyContent), copyLabel: rect(copyLabel), contentMask: content && getComputedStyle(content).maskImage, prefixMask: prefix && getComputedStyle(prefix).maskImage, iconMask: icon && getComputedStyle(icon).maskImage, copyLabelMask: copyLabel && getComputedStyle(copyLabel).maskImage, icon: rect(icon), label: rect(label), prefix: prefix?.textContent, labelText: label?.textContent, text: content?.textContent, baseColor: content && getComputedStyle(content).color, iconColor: icon && getComputedStyle(icon).color, labelColor: labelStyle?.color, sweepColor: style?.color, activeSweep: element.dataset.animating, preview: element.dataset.preview, overflowing: element.dataset.overflow === 'true', gap: icon && (prefix || label) ? (prefix || label).getBoundingClientRect().left - icon.getBoundingClientRect().right : null, prefixGap: prefix && label ? label.getBoundingClientRect().left - prefix.getBoundingClientRect().right : null, labelScrollWidth: label?.scrollWidth, labelClientWidth: label?.clientWidth, labelWhiteSpace: labelStyle?.whiteSpace, labelMask: labelStyle?.maskImage, labelTextOverflow: labelStyle?.textOverflow, sweepMask: style?.maskImage, sharedMask: getComputedStyle(element).getPropertyValue('--activity-shimmer-mask').trim(), sweepDisplay: style?.display, sweepDuration: style?.animationDuration, sweepDelay: style?.animationDelay, sweepTiming: style?.animationTimingFunction, sweepTransform: style?.transform, sweepX: style && new DOMMatrixReadOnly(style.transform).m41, keyframes: animations[0]?.effect?.getKeyframes().map(frame => ({ offset: frame.offset, transform: frame.transform })), copyHidden: sweep?.getAttribute('aria-hidden'), copyInert: sweep?.inert, copyTextNodes: sweep?.textContent };
  };
  return { turn: rect(turn), messages: rect(messages), scrollTop: messages?.scrollTop, text: header?.textContent, workLabel: header?.querySelector('.turn-work-label')?.textContent, workLabelX: header?.querySelector('.turn-work-label')?.getBoundingClientRect().x, headerIcons: header?.querySelectorAll('svg').length, phase: header?.getAttribute('data-phase'), header: rect(header), history: rect(history), row: rect(row), expanded: row?.getAttribute('aria-expanded'), headerIndex: turn && header ? [...turn.children].indexOf(header) : -1, totalInsideHistory: !!history?.querySelector('.turn-duration'), footer: !!document.querySelector('.turn-status-footer'), overflow: document.documentElement.scrollWidth > innerWidth, activities: [...(history?.querySelectorAll('.activity-text[data-active="true"]') ?? [])].map(activity) };
})()`;
const settle =
  "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))";
function expectedReasoningExcerpt(content) {
  const characters = [...content.replace(/\s+/gu, " ").trim()];
  if (characters.length <= 240) return characters.join("");
  let text = characters.slice(-238).join("");
  if (
    /[A-Za-z0-9_]/u.test(characters[characters.length - 239] ?? "") &&
    /^[A-Za-z0-9_]/u.test(text)
  )
    text = text.replace(/^[A-Za-z0-9_]+(?:[.,:;!?])?\s+/u, "");
  return `… ${text}`;
}
const evidence = {
  source:
    "Synthetic authored public item.content and commands; production Sidebar, ThreadView, ActivityText and CSS. No Host actions or hidden model reasoning.",
  contract: {
    mask: "shared width-relative 105deg, transparent 0%, black 40% 60%, transparent 100%",
    duration: "1.5s",
    easing: "steps(48, end)",
    delay: "0.3s",
    travel: "-100% to +100% through 66.6667%, then hold",
    overflow: "one line, 48px trailing fade only when overflowing",
  },
  scenes: [],
};
function assertPreview(value, expected, name, overflowing) {
  assert.equal(value.preview, "true", `${name}: actual content preview`);
  assert.equal(
    value.labelText,
    expected,
    `${name}: actual public text or full command`,
  );
  assert.equal(value.gap, 6, `${name}: original icon/prefix spacing`);
  assert.equal(value.prefixGap, 6, `${name}: prefix/content spacing`);
  assert.equal(value.labelWhiteSpace, "nowrap", `${name}: one line`);
  assert.equal(value.labelTextOverflow, "clip", `${name}: fade, not ellipsis`);
  assert.equal(value.overflowing, overflowing, `${name}: measured overflow`);
  if (overflowing)
    assert.match(value.labelMask, /48px/u, `${name}: 48px end fade`);
  else
    assert.equal(
      value.labelMask,
      "none",
      `${name}: short text has no end fade`,
    );
  assert.equal(
    value.contentMask,
    "none",
    `${name}: content container is not faded`,
  );
  assert.equal(value.prefixMask, "none", `${name}: prefix stays unfaded`);
  assert.equal(value.iconMask, "none", `${name}: icon stays unfaded`);
  assert.equal(
    value.copyLabelMask,
    value.labelMask,
    `${name}: both labels share fade`,
  );
  assert.ok(
    Math.abs(value.copyContent.width - value.content.width) < 1,
    `${name}: decorative content width matches`,
  );
  assert.ok(
    Math.abs(value.copyLabel.width - value.label.width) < 1,
    `${name}: decorative excerpt width matches`,
  );
  assert.equal(value.copyHidden, "true", `${name}: decorative copy is hidden`);
  assert.equal(value.copyInert, true, `${name}: decorative copy is inert`);
  assert.equal(
    value.copyTextNodes,
    "",
    `${name}: no duplicated accessible text`,
  );
}
function assertSweep(value, entry, name) {
  const expectedBase =
    entry.theme === "dark" ? "rgb(137, 140, 150)" : "rgb(97, 104, 120)";
  const expectedCrest =
    entry.theme === "dark" ? "rgb(240, 241, 243)" : "rgb(28, 32, 41)";
  assert.equal(value.activeSweep, "true", `${name}: visible active sweep`);
  assert.equal(value.baseColor, expectedBase, `${name}: muted base`);
  assert.equal(value.iconColor, expectedBase, `${name}: muted icon`);
  assert.equal(value.labelColor, expectedBase, `${name}: muted text`);
  assert.equal(value.sweepColor, expectedCrest, `${name}: foreground crest`);
  assert.match(value.sweepMask, /105deg/u, `${name}: DSH diagonal mask`);
  assert.match(
    value.sharedMask,
    /40% 60%/u,
    `${name}: shared width-relative mask`,
  );
  assert.equal(value.sweepDuration, "1.5s", `${name}: exact duration`);
  assert.equal(value.sweepDelay, "0.3s", `${name}: exact delay`);
  assert.match(
    value.sweepTiming,
    /^steps\(48(?:, end)?\)$/u,
    `${name}: stepped travel`,
  );
  assert.ok(
    value.keyframes.some(
      (frame) => Math.abs(frame.offset - 0.666667) < 0.00001,
    ),
    `${name}: travel ends at two thirds`,
  );
}
await withPreviewBrowser(
  directory,
  async ({ send, evaluate, url, screenshot }) => {
    const animationTime = async (time) => {
      await evaluate(
        `document.getAnimations().forEach(a => { a.pause(); a.currentTime = ${time}; })`,
      );
      await evaluate(settle);
    };
    const crop = async (rect) => {
      assert.ok(
        rect && rect.width > 0 && rect.height > 0,
        "Visible screenshot crop",
      );
      return send("Page.captureScreenshot", {
        format: "png",
        clip: { ...rect, scale: 1 },
      });
    };
    // Decode both screenshots before comparing: PNG bytes alone do not prove pixel changes.
    const pixelDifference = async (first, second) =>
      evaluate(`(async () => {
    const decode = async data => {
      const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      return ctx.getImageData(0, 0, image.width, image.height).data;
    };
    const a = await decode(${JSON.stringify(first.data)}), b = await decode(${JSON.stringify(second.data)});
    if (a.length !== b.length) throw new Error('Screenshot crop dimensions changed');
    let changedPixels = 0, maxChannelDelta = 0;
    for (let index = 0; index < a.length; index += 4) {
      const delta = Math.max(Math.abs(a[index]-b[index]), Math.abs(a[index+1]-b[index+1]), Math.abs(a[index+2]-b[index+2]));
      if (delta > 2) changedPixels++; maxChannelDelta = Math.max(maxChannelDelta, delta);
    }
    return { changedPixels, maxChannelDelta };
  })()`);
    for (const entry of matrix) {
      const name = `${entry.scene}-${entry.theme}-${entry.width}${entry.lang === "en" ? "-en" : ""}`;
      await send("Emulation.setDeviceMetricsOverride", {
        width: entry.width,
        height: entry.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send("Page.navigate", {
        url: `${url}/process-style-frame.html?scene=${entry.scene}&theme=${entry.theme}&lang=${entry.lang}`,
      });
      for (let attempt = 0; attempt < 200; attempt++) {
        if (
          await evaluate(
            "Boolean(window.__processStylePreview && document.querySelector('.turn-history'))",
          )
        )
          break;
        if (attempt === 199) throw new Error("Fixture did not mount");
        await delay(50);
      }
      await delay(300);
      await animationTime(800);
      const before = await evaluate(measure);
      assert.ok(before.header && before.history, `${name}: header and history`);
      assert.ok(
        before.header.y < before.history.y,
        `${name}: total above history`,
      );
      assert.equal(before.headerIndex, 1, `${name}: top metadata sibling`);
      assert.equal(before.totalInsideHistory, false);
      assert.equal(before.footer, false);
      assert.equal(before.overflow, false, `${name}: no page overflow`);
      assert.equal(before.headerIcons, 0, `${name}: no leading phase icon`);
      const labelPattern =
        entry.scene === "recovery"
          ? entry.lang === "en"
            ? /^Working$/u
            : /^正在工作$/u
          : entry.lang === "en"
            ? /^Working for \d/u
            : /^已工作 \d/u;
      assert.match(
        before.workLabel,
        labelPattern,
        `${name}: work-duration wording`,
      );
      assert.doesNotMatch(
        before.workLabel,
        /总耗时|Total elapsed|等待中|Waiting/u,
      );
      const details = {};
      if (entry.scene === "wait-lifecycle") {
        const rows = await evaluate(
          `([...document.querySelectorAll('.trace-singleton, .trace-group')].map(row => ({ text: row.textContent, active: row.querySelector('.activity-text')?.dataset.active, sweep: !!row.querySelector('.activity-sweep') })))`,
        );
        assert.equal(
          rows.length,
          3,
          "Three assistant-separated lifecycle rows",
        );
        assert.equal(rows[0].active, "true", "Origin shell remains active");
        assert.equal(rows[1].active, "false", "Returned wait is settled");
        assert.equal(rows[1].sweep, false, "Returned wait has no sweep");
        assert.match(rows[1].text, /Waited/u);
        assert.doesNotMatch(rows[1].text, /Waiting/u);
        assert.equal(rows[2].active, "true", "Pending wait remains active");
        assert.equal(rows[2].sweep, true, "Pending wait has sweep");
        assert.match(rows[2].text, /Waiting/u);
        assertSweep(before.activities[0], entry, `${name} origin shell`);
        assertSweep(before.activities[1], entry, `${name} pending wait`);
        await animationTime(300);
        const start = await crop(before.activities[1].rect);
        await screenshot(`${name}-sweep-start.png`);
        await animationTime(800);
        const pixels = await pixelDifference(
          start,
          await crop(before.activities[1].rect),
        );
        assert.ok(
          pixels.changedPixels >= 4 && pixels.maxChannelDelta >= 10,
          "Pending wait pixels visibly sweep",
        );
        details.waitLifecycle = { rows, pendingWaitPixels: pixels };
      }

      if (previewScenes.includes(entry.scene)) {
        const samples = await evaluate("window.__processStylePreview.samples");
        const reasoning = entry.scene.startsWith("thinking");
        const short = entry.scene.endsWith("-short");
        const empty = entry.scene.endsWith("-empty");
        const expected = reasoning
          ? empty
            ? ""
            : short
              ? samples.publicReasoning.short
              : expectedReasoningExcerpt(samples.publicReasoning.long)
          : samples.commands[short ? "short" : "long"];
        const active = before.activities[0];
        assert.ok(active, `${name}: active summary exists`);
        assert.equal(
          before.expanded,
          "false",
          `${name}: trace starts collapsed`,
        );
        assertPreview(active, expected, name, !short && !empty);
        assertSweep(active, entry, name);
        if (reasoning)
          assert.equal(
            active.prefix,
            entry.lang === "en" ? "Thinking" : "思考中",
          );
        await screenshot(`${name}.png`);

        await animationTime(300);
        const start = (await evaluate(measure)).activities[0];
        assert.ok(
          Math.abs(start.sweepX + start.rect.width) < 1,
          `${name}: starts at -100%`,
        );
        const iconStart = await crop(start.icon);
        const labelStart = empty ? null : await crop(start.label);
        await animationTime(550);
        const iconCrest = await crop(start.icon);
        const iconPixels = await pixelDifference(iconStart, iconCrest);
        assert.ok(
          iconPixels.changedPixels >= 4 && iconPixels.maxChannelDelta >= 10,
          `${name}: actual icon pixels visibly brighten`,
        );
        await animationTime(800);
        const labelPixels = empty
          ? null
          : await pixelDifference(labelStart, await crop(start.label));
        if (labelPixels)
          assert.ok(
            labelPixels.changedPixels >= 4 && labelPixels.maxChannelDelta >= 10,
            `${name}: actual content pixels visibly brighten`,
          );
        await screenshot(`${name}-sweep-later.png`);
        await animationTime(1400);
        const hold = (await evaluate(measure)).activities[0];
        await animationTime(1750);
        const holdLater = (await evaluate(measure)).activities[0];
        assert.ok(
          Math.abs(hold.sweepX - hold.rect.width) < 1,
          `${name}: reaches +100%`,
        );
        assert.equal(
          holdLater.sweepTransform,
          hold.sweepTransform,
          `${name}: holds for final third`,
        );
        details.pixels = { icon: iconPixels, content: labelPixels };
        details.travel = {
          start: start.sweepX,
          end: hold.sweepX,
          hold: holdLater.sweepX,
        };

        await evaluate("document.querySelector('.trace-toggle').click()");
        await delay(200);
        await animationTime(800);
        const expanded = await evaluate(measure);
        assert.equal(expanded.expanded, "true", `${name}: trace expands`);
        assert.equal(expanded.overflow, false, `${name}: expanded layout fits`);
        assertPreview(
          expanded.activities[0],
          expected,
          `${name} expanded group`,
          !short && !empty,
        );
        if (!empty) {
          assert.equal(
            expanded.activities.length,
            2,
            `${name}: active group and actual item`,
          );
          assertPreview(
            expanded.activities[1],
            expected,
            `${name} expanded item`,
            !short,
          );
          assertSweep(expanded.activities[1], entry, `${name} expanded item`);
          await evaluate(
            "document.querySelector('.trace-items .activity-text[data-active=\"true\"]').closest('button').click()",
          );
          await delay(200);
        }
        await screenshot(`${name}-expanded.png`);
        details.expanded = expanded;
        // Keep the original DOM identities, disclosure and keyboard focus through live updates.
        await evaluate(
          `window.__previewNodes = { group: document.querySelector('.trace-toggle'), content: document.querySelector('.trace-toggle .activity-content'), item: document.querySelector('.trace-items .activity-text[data-active="true"]')?.closest('button') }; window.__previewNodes.group.focus()`,
        );
        if (reasoning)
          await evaluate("window.__processStylePreview.streamStep()");
        else
          await evaluate(
            `window.__processStylePreview.setCommand(${JSON.stringify(samples.commands.long + " --stream-update synthetic-latest")})`,
          );
        await delay(100);
        await animationTime(800);
        const streamed = await evaluate(measure);
        const identity = await evaluate(
          `({ group: window.__previewNodes.group === document.querySelector('.trace-toggle'), content: window.__previewNodes.content === document.querySelector('.trace-toggle .activity-content'), focused: document.activeElement === window.__previewNodes.group, itemExpanded: window.__previewNodes.item?.getAttribute('aria-expanded') })`,
        );
        assert.equal(identity.group, true, `${name}: stable group node`);
        assert.equal(identity.content, true, `${name}: stable content node`);
        assert.equal(identity.focused, true, `${name}: preserves focus`);
        if (!empty)
          assert.equal(
            identity.itemExpanded,
            "true",
            `${name}: preserves item disclosure`,
          );
        assert.equal(
          streamed.expanded,
          "true",
          `${name}: preserves group disclosure`,
        );
        assert.equal(
          streamed.row.height,
          before.row.height,
          `${name}: streaming stays one line`,
        );
        assert.equal(
          streamed.overflow,
          false,
          `${name}: streaming fits viewport`,
        );
        const updatedText = reasoning
          ? samples.streamChunks[0].trim()
          : "--stream-update synthetic-latest";
        assert.ok(
          streamed.activities[0].labelText.endsWith(updatedText),
          `${name}: latest stream reaches visible excerpt`,
        );
        await screenshot(`${name}-streamed.png`);
        details.streamed = { ...streamed, identity };

        // Resize the content, not the item: overflow/fade must clear and reappear.
        if (reasoning)
          await evaluate(
            "window.__processStylePreview.setReasoning(window.__processStylePreview.samples.publicReasoning.short)",
          );
        else
          await evaluate(
            "window.__processStylePreview.setCommand(window.__processStylePreview.samples.commands.short)",
          );
        await delay(100);
        const shrunk = (await evaluate(measure)).activities[0];
        assertPreview(
          shrunk,
          reasoning ? samples.publicReasoning.short : samples.commands.short,
          `${name} shrunk`,
          false,
        );
        if (reasoning)
          await evaluate(
            "window.__processStylePreview.setReasoning(window.__processStylePreview.samples.publicReasoning.long)",
          );
        else
          await evaluate(
            "window.__processStylePreview.setCommand(window.__processStylePreview.samples.commands.long)",
          );
        await delay(100);
        const grown = (await evaluate(measure)).activities[0];
        assert.equal(grown.overflowing, true, `${name}: growth restores fade`);
        assert.match(grown.labelMask, /48px/u);
        details.resize = { short: shrunk, long: grown };
        await send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-reduced-motion", value: "reduce" }],
        });
        await evaluate(settle);
        const reduced = await evaluate(measure);
        for (const value of reduced.activities)
          assert.equal(
            value.sweepDisplay,
            "none",
            `${name}: reduced motion removes sweep`,
          );
        assert.equal(reduced.overflow, false);
        await screenshot(`${name}-reduced-motion.png`);
        details.reduced = reduced;
        await send("Emulation.setEmulatedMedia", { features: [] });
      } else {
        await screenshot(`${name}.png`);
      }
      // The expanded transcript can scroll during live-follow or focus. Compare
      // the same-turn content anchor, not an earlier collapsed viewport position.
      await evaluate(settle);
      const beforeCompletion = await evaluate(measure);
      await evaluate("window.__processStylePreview.finish()");
      await delay(200);
      const after = await evaluate(measure);
      await writeFile(
        path.join(directory, "latest-completion.json"),
        JSON.stringify({ ...entry, beforeCompletion, after }, null, 2) + "\n",
      );
      assert.equal(
        after.headerIndex,
        before.headerIndex,
        `${name}: stable completed metadata`,
      );
      assert.ok(
        Math.abs(
          after.header.y -
            after.turn.y -
            (beforeCompletion.header.y - beforeCompletion.turn.y),
        ) < 1,
        `${name}: header keeps its same-turn layout anchor`,
      );
      assert.ok(
        Math.abs(
          after.header.y -
            after.messages.y +
            after.scrollTop -
            (beforeCompletion.header.y -
              beforeCompletion.messages.y +
              beforeCompletion.scrollTop),
        ) < 1,
        `${name}: header keeps its scroll-normalized transcript position`,
      );
      assert.equal(after.totalInsideHistory, false);
      assert.ok(
        Math.abs(
          after.workLabelX -
            after.turn.x -
            (beforeCompletion.workLabelX - beforeCompletion.turn.x),
        ) < 1,
        `${name}: stable text anchor`,
      );
      assert.match(
        after.workLabel,
        entry.lang === "en" ? /^Worked for \d/u : /^已工作 \d/u,
      );
      assert.equal(
        after.activities.length,
        0,
        `${name}: completion stops activity`,
      );
      await screenshot(`${name}-completed.png`);
      evidence.scenes.push({
        ...entry,
        before,
        ...details,
        beforeCompletion,
        after,
      });
      // Keep useful partial evidence if a later scene fails in CI.
      await writeFile(
        path.join(directory, "measurements.json"),
        JSON.stringify(evidence, null, 2) + "\n",
      );
    }
  },
);
console.log(
  `Captured ${matrix.length} synthetic scenes: long/short/empty previews, collapsed/expanded streaming, decoded icon/content pixel changes, exact DSH choreography, reduced motion, and same-turn completion.`,
);
