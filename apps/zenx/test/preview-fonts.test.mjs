import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  fontAssets,
  fontRevision,
  fontURL,
  verifyFontBytes,
  coversText,
  preparePreviewFonts,
} from "../scripts/prepare-preview-fonts.mjs";
import {
  probePreviewFonts,
  fontProbeHTML,
} from "../scripts/preview-font-probe.mjs";
import { readingPathsChanged } from "../scripts/reading-main-ui-preview.mjs";

test("official font URLs and full immutable file digests are pinned", () => {
  assert.match(fontRevision, /^[a-f0-9]{40}$/);
  for (const font of fontAssets) {
    assert.match(font.sha256, /^[a-f0-9]{64}$/);
    const url = new URL(fontURL(font));
    assert.equal(url.origin, "https://raw.githubusercontent.com");
    assert.equal(
      url.pathname,
      `/notofonts/noto-cjk/${fontRevision}/Sans/OTC/${font.name}`,
    );
  }
});
test("every source, including cache, must have both expected bytes and hash", () => {
  const bytes = Buffer.from("font data"),
    asset = {
      name: "test",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  verifyFontBytes(bytes, asset);
  assert.throws(
    () => verifyFontBytes(Buffer.from("bad data!"), asset),
    /SHA256/,
  );
  assert.throws(() => verifyFontBytes(Buffer.from("bad"), asset), /byte count/);
});
test("fontconfig coverage must include every real Chinese specimen character", () => {
  assert(coversText("4e00-9fff"));
  assert(!coversText("20-7e"));
  assert(coversText("4e2d 6587", "中文"));
  assert(!coversText("4e2d 6587", "中文阅"));
});
test("missing pinned font fails clearly without implicitly enabling downloads", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "font-missing-"));
  try {
    let called = false;
    await assert.rejects(
      preparePreviewFonts(dir, {
        systemDirectory: path.join(dir, "absent"),
        fetchFont: () => {
          called = true;
        },
      }),
      /downloads were not authorized/,
    );
    assert(!called);
    assert.equal(
      JSON.parse(await readFile(path.join(dir, "fonts.json"), "utf8")).status,
      "failed",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("bad cache is not used, ignored or silently redownloaded", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "font-corrupt-"));
  try {
    await writeFile(path.join(dir, fontAssets[0].name), "corrupt");
    let called = false;
    await assert.rejects(
      preparePreviewFonts(dir, {
        allowDownload: true,
        fetchFont: () => {
          called = true;
        },
      }),
      /Font byte count/,
    );
    assert(!called);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("official fetch is single-shot, timeout-bounded and rejects redirects/failure", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "font-offline-"));
  try {
    let calls = 0;
    await assert.rejects(
      preparePreviewFonts(dir, {
        systemDirectory: path.join(dir, "absent"),
        allowDownload: true,
        fetchFont: async (url, options) => {
          calls++;
          assert.equal(url, fontURL(fontAssets[0]));
          assert.equal(options.redirect, "error");
          assert(options.signal instanceof AbortSignal);
          return { ok: false, status: 503 };
        },
      }),
      /HTTP 503/,
    );
    assert.equal(calls, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
const fakeProbe = (bad = false) => {
  const calls = [];
  return {
    calls,
    send: async (method, params) => {
      calls.push({ method, params });
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector")
        return { nodeId: params.selector === "#regular" ? 2 : 3 };
      if (method === "CSS.getPlatformFontsForNode")
        return {
          fonts: [
            {
              familyName: "Noto Sans CJK SC",
              postScriptName: bad
                ? "LastResort"
                : params.nodeId === 2
                  ? "NotoSansCJKsc-Regular"
                  : "NotoSansCJKsc-Bold",
              glyphCount: 24,
              isCustomFont: false,
            },
          ],
        };
      return {};
    },
  };
};
test("Chrome probe verifies real platform faces for both weights and rejects fallback", async () => {
  const good = fakeProbe();
  const receipt = await probePreviewFonts(
    good.send,
    async () => true,
    "http://127.0.0.1:1000",
  );
  assert.equal(receipt.faces.length, 2);
  assert.match(receipt.scope, /not a product UI/);
  const bad = fakeProbe(true);
  await assert.rejects(
    probePreviewFonts(bad.send, async () => true, "http://127.0.0.1:1000"),
    /Actual Chrome face/,
  );
  assert.match(fontProbeHTML, /lang="zh-CN"/);
  assert.match(fontProbeHTML, /default-src 'none'/);
});
test("desktop job caches fixed data, removes apt, retains sandbox and automatically gates font changes", async () => {
  const workflow = await readFile(
    new URL(
      "../../../.github/workflows/desktop-reading-ui.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(workflow, /sudo|apt-get|continue-on-error/);
  assert.match(workflow, /actions\/cache@v4/);
  assert(workflow.includes(fontRevision));
  assert.match(workflow, /prepare-preview-fonts.mjs.*--allow-download/);
  assert.match(workflow, /ZENX_PREVIEW_FONT_RECEIPT:/);
  for (const file of [
    "apps/zenx/scripts/prepare-preview-fonts.mjs",
    "apps/zenx/scripts/preview-font-probe.mjs",
    "apps/zenx/scripts/preview-fonts-OFL.txt",
    "apps/zenx/test/preview-fonts.test.mjs",
  ]) {
    assert(readingPathsChanged([file]));
    assert(workflow.includes(file));
  }
  const capture = await readFile(
    new URL("../scripts/capture-main-ui-preview.mjs", import.meta.url),
    "utf8",
  );
  assert.match(capture, /process.env.GITHUB_ACTIONS,\s*"true"/);
  assert.doesNotMatch(capture, /["']--no-sandbox/);
  assert.match(capture, /hash\(await readFile\(fontPath\)\), asset.sha256/);
  assert.match(capture, /fontProbe.sha256 = hash\(bytes\)/);
});
