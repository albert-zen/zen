/** Fixed official Noto Sans CJK data, not an apt mirror or executable package. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const fontRevision = "523d033d6cb47f4a80c58a35753646f5c3608a78";
export const fontSample = "中文阅读对话资料侧栏审批继续等待未决定简體繁體";
export const fontAssets = [
  {
    name: "NotoSansCJK-Regular.ttc",
    style: "Regular",
    sha256: "b76b0433203017ca80401b2ee0dd69350349871c4b19d504c34dbdd80541690a",
    bytes: 19484784,
  },
  {
    name: "NotoSansCJK-Bold.ttc",
    style: "Bold",
    sha256: "faa5f3656a78b2e2d450d27fe8382c778bc2b6bb5ea29c986664a6a435056ceb",
    bytes: 20050760,
  },
];
export const fontURL = (asset) =>
  `https://raw.githubusercontent.com/notofonts/noto-cjk/${fontRevision}/Sans/OTC/${asset.name}`;
export function verifyFontBytes(bytes, asset) {
  assert.equal(bytes.length, asset.bytes, `Font byte count: ${asset.name}`);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    asset.sha256,
    `Font SHA256: ${asset.name}`,
  );
}
export function coversText(charset, text = fontSample) {
  const ranges = charset
    .trim()
    .split(/\s+/)
    .map((range) => range.split("-").map((n) => parseInt(n, 16)));
  return [...text].every((char) =>
    ranges.some(
      ([start, end = start]) =>
        char.codePointAt(0) >= start && char.codePointAt(0) <= end,
    ),
  );
}
const xml = (s) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
export async function preparePreviewFonts(
  directory,
  {
    allowDownload = false,
    fetchFont = fetch,
    systemDirectory = "/usr/share/fonts/opentype/noto",
  } = {},
) {
  const started = performance.now();
  await mkdir(directory, { recursive: true });
  const receipt = {
    repository: "notofonts/noto-cjk",
    revision: fontRevision,
    release: "Sans2.004",
    license: `https://github.com/notofonts/noto-cjk/blob/${fontRevision}/LICENSE`,
    sample: fontSample,
    assets: [],
    status: "preparing",
  };
  const receiptPath = path.join(directory, "fonts.json");
  try {
    for (const asset of fontAssets) {
      const destination = path.join(directory, asset.name);
      let bytes, source;
      for (const [candidate, label] of [
        [destination, "verified-cache"],
        [path.join(systemDirectory, asset.name), "verified-preinstalled"],
      ]) {
        try {
          bytes = await readFile(candidate);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          continue;
        }
        // A present but corrupt/different font is an explicit failure, not a silent environment change.
        verifyFontBytes(bytes, asset);
        source = label;
        break;
      }
      if (!bytes) {
        assert(
          allowDownload,
          `Pinned font missing: ${asset.name}; downloads were not authorized for this invocation`,
        );
        const response = await fetchFont(fontURL(asset), {
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        });
        assert(
          response.ok,
          `Official font download failed: ${asset.name} HTTP ${response.status}`,
        );
        bytes = Buffer.from(await response.arrayBuffer());
        verifyFontBytes(bytes, asset);
        source = "official-pinned-download";
      }
      await writeFile(destination, bytes);
      receipt.assets.push({ ...asset, source, url: fontURL(asset) });
    }
    await writeFile(
      path.join(directory, "OFL.txt"),
      await readFile(new URL("./preview-fonts-OFL.txt", import.meta.url)),
    );
    const config = path.join(directory, "fonts.conf");
    const cacheDirectory = `${directory}-cache`;
    await mkdir(cacheDirectory, { recursive: true });
    // Inherit normal system matching; add only the private data/cache dirs. No system config or sudo.
    await writeFile(
      config,
      `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig><include ignore_missing="no">/etc/fonts/fonts.conf</include><dir>${xml(directory)}</dir><cachedir>${xml(cacheDirectory)}</cachedir></fontconfig>\n`,
    );
    const env = {
      ...process.env,
      FONTCONFIG_FILE: config,
      XDG_CACHE_HOME: cacheDirectory,
    };
    execFileSync("fc-cache", [directory], { env, timeout: 15_000 });
    for (const asset of receipt.assets) {
      const scan = execFileSync(
        "fc-scan",
        [
          "--format",
          "%{family}|%{style}|%{charset}\\n",
          path.join(directory, asset.name),
        ],
        { env, encoding: "utf8", timeout: 10_000 },
      );
      const face = scan
        .trim()
        .split("\n")
        .map((line) => line.split("|"))
        .find(
          ([family, style]) =>
            family === "Noto Sans CJK SC" && style === asset.style,
        );
      assert(
        face && coversText(face[2]),
        `Pinned ${asset.style} SC face must cover every probe character`,
      );
      const matched = execFileSync(
        "fc-match",
        [
          "--format",
          "%{file}",
          `Noto Sans CJK SC:style=${asset.style}:lang=zh-cn`,
        ],
        { env, encoding: "utf8", timeout: 10_000 },
      ).trim();
      verifyFontBytes(await readFile(matched), asset);
      asset.family = face[0];
      asset.coverageVerified = true;
    }
    receipt.status = "ready";
    receipt.durationMs = Math.round(performance.now() - started);
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
    return { config, receiptPath, receipt };
  } catch (error) {
    receipt.status = "failed";
    receipt.durationMs = Math.round(performance.now() - started);
    receipt.error = String(error);
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
    throw error;
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  assert(process.argv[2], "Pass a private preview-font directory");
  const result = await preparePreviewFonts(path.resolve(process.argv[2]), {
    allowDownload: process.argv[3] === "--allow-download",
  });
  console.log(JSON.stringify(result.receipt));
}
