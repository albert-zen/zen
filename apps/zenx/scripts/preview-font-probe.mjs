import assert from "node:assert/strict";
import { fontSample } from "./prepare-preview-fonts.mjs";

/** Infrastructure specimen only, never presented as a production UI screenshot. */
export const fontProbeHTML = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{margin:32px;background:white;color:#181818;font-family:'Noto Sans CJK SC';font-size:24px}#bold{font-weight:700}</style><title>CJK font infrastructure probe, not product UI</title><p id="regular">${fontSample}</p><p id="bold">${fontSample}</p></html>`;
export async function probePreviewFonts(send, evaluate, origin) {
  await send("Page.navigate", { url: `${origin}/font-probe.html` });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (
      await evaluate(
        "location.pathname === '/font-probe.html' && !!document.querySelector('#bold')",
      )
    ) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert(ready, "Font specimen did not load");
  await evaluate(
    "document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))",
  );
  await send("DOM.enable");
  await send("CSS.enable");
  const { root } = await send("DOM.getDocument");
  const faces = [];
  for (const [selector, postScriptName] of [
    ["#regular", "NotoSansCJKsc-Regular"],
    ["#bold", "NotoSansCJKsc-Bold"],
  ]) {
    const { nodeId } = await send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector,
    });
    const { fonts } = await send("CSS.getPlatformFontsForNode", { nodeId });
    const used = fonts.filter((font) => font.glyphCount > 0);
    assert.equal(used.length, 1, `No tofu/fallback in ${selector}`);
    assert.equal(
      used[0].postScriptName,
      postScriptName,
      `Actual Chrome face for ${selector}`,
    );
    assert.equal(
      used[0].isCustomFont,
      false,
      "Use verified platform font, not network webfont",
    );
    faces.push({ selector, ...used[0] });
  }
  return {
    scope: "Infrastructure-only Chinese glyph specimen, not a product UI scene",
    text: fontSample,
    faces,
  };
}
