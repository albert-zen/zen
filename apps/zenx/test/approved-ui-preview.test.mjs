import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Script } from "node:vm";
import test from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
const execute = promisify(execFile);
const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Generated fixture did not reach expected DOM state");
};
test("the exact CI-generated approved UI HTML parses, boots and uses real modifier/context paths", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "zenx-approved-ui-test-"),
  );
  try {
    await execute(
      process.execPath,
      [
        new URL("../scripts/build-approved-ui-preview.mjs", import.meta.url)
          .pathname,
        directory,
      ],
      { maxBuffer: 2 * 1024 * 1024 },
    );
    const provenance = JSON.parse(
      await readFile(path.join(directory, "source.json"), "utf8"),
    );
    assert.deepEqual(provenance.sidebarBaseline, {
      commit: "dfd427541ced50a4c076ca131d4fd8e9107336f3",
      blob: "464e3f45d7b9c691ec5f930657a3f073f1fb98df",
    });
    assert.match(provenance.note, /not a historical full-app build/);
    for (const variant of ["before", "after"]) {
      for (const kind of ["sidebar", "context", "context-unavailable"]) {
        const fileKind = kind === "context-unavailable" ? "context" : kind;
        const html = await readFile(
          path.join(directory, `${fileKind}-${variant}.html`),
          "utf8",
        );
        const parsed = new JSDOM(html);
        const scripts = [...parsed.window.document.querySelectorAll("script")];
        assert.equal(
          scripts.length,
          1,
          `${kind}/${variant}: complete uncorrupted inline script`,
        );
        for (const script of scripts) new Script(script.textContent);
        parsed.window.close();
        const errors = [];
        const virtualConsole = new VirtualConsole();
        virtualConsole.on("jsdomError", (error) => {
          if (
            error.type !== "css-parsing" &&
            !String(error.message).includes("Could not parse CSS stylesheet")
          )
            errors.push(String(error));
        });
        const dom = new JSDOM(html, {
          url: `http://localhost/${kind}-${variant}.html?platform=win32&theme=dark&width=220&lang=zh-CN${kind === "context-unavailable" ? "&context=unknown" : ""}`,
          pretendToBeVisual: true,
          runScripts: "dangerously",
          virtualConsole,
          beforeParse(window) {
            Object.defineProperty(window.document, "fonts", {
              value: { ready: Promise.resolve() },
            });
            window.matchMedia = () => ({
              matches: false,
              addEventListener() {},
              removeEventListener() {},
              addListener() {},
              removeListener() {},
            });
          },
        });
        try {
          const { document } = dom.window;
          if (kind === "context-unavailable") {
            await waitFor(() =>
              document.querySelector(".motion-preview-controls"),
            );
            assert.equal(
              document.querySelector(".context-usage-trigger"),
              null,
            );
            assert.equal(
              document.querySelector(".context-usage-breakdown"),
              null,
              "unknown is not four fake zero categories",
            );
          } else if (kind === "sidebar") {
            await waitFor(() => dom.window.__sidebarVisual?.ready);
            assert.equal(
              document.querySelectorAll(".thread-row-shell").length,
              5,
            );
            dom.window.__sidebarVisual.setModifier(true);
            await waitFor(
              () =>
                document.querySelectorAll(".thread-row[data-shortcut-key]")
                  .length === 5,
            );
            dom.window.__sidebarVisual.setModifier(false);
            await waitFor(
              () =>
                document.querySelectorAll(".thread-row[data-shortcut-key]")
                  .length === 0,
            );
            dom.window.__sidebarVisual.setModifier(true);
            await waitFor(
              () =>
                document.querySelectorAll(".thread-row[data-shortcut-key]")
                  .length === 5,
            );
            dom.window.__sidebarVisual.blur();
            await waitFor(
              () =>
                document.querySelectorAll(".thread-row[data-shortcut-key]")
                  .length === 0,
            );
          } else {
            await waitFor(() =>
              document.querySelector(".context-usage-trigger"),
            );
            const trigger = document.querySelector(".context-usage-trigger");
            trigger.focus();
            await waitFor(() =>
              document.querySelector(".context-usage-popover"),
            );
            const rows = [
              ...document.querySelectorAll(".context-usage-breakdown > div"),
            ];
            assert.equal(rows.length, 4);
            assert.match(rows[0].textContent, /系统与仓库指令/u);
            assert.match(rows[1].textContent, /工具定义.*含插件/u);
            assert.match(rows[2].textContent, /插件注入上下文/u);
            assert.match(rows[3].textContent, /对话与工具结果/u);
            assert.match(
              document.querySelector(".context-usage-popover").textContent,
              /非计费值/u,
            );
            assert.doesNotMatch(
              document.querySelector(".context-usage-popover").textContent,
              /MCP/u,
            );
            trigger.dispatchEvent(
              new dom.window.KeyboardEvent("keydown", {
                key: "Escape",
                bubbles: true,
              }),
            );
            await waitFor(
              () => !document.querySelector(".context-usage-popover"),
            );
          }
          assert.deepEqual(
            errors,
            [],
            `${kind}/${variant}: no boot/runtime exceptions`,
          );
        } finally {
          dom.window.close();
        }
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
