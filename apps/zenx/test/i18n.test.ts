import assert from "node:assert/strict";
import test from "node:test";
import { i18n, resources } from "../src/renderer/src/i18n.js";
import { nativeText, setNativeLanguage } from "../src/main/native-locale.js";

const placeholders = (value: string) =>
  [...value.matchAll(/\{\{\s*([^},\s]+)[^}]*\}\}/gu)]
    .map((match) => match[1])
    .sort();

test("every bundled English message has a Chinese translation with matching interpolation variables", () => {
  for (const namespace of Object.keys(
    resources.en,
  ) as (keyof typeof resources.en)[]) {
    const en: Record<string, string> = resources.en[namespace];
    const zh: Record<string, string> = resources["zh-CN"][namespace];
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), namespace);
    for (const [key, value] of Object.entries(en)) {
      assert.ok(zh[key]?.trim(), `${namespace}:${key} cannot be empty`);
      assert.deepEqual(
        placeholders(zh[key]!),
        placeholders(value),
        `${namespace}:${key} placeholders`,
      );
    }
  }
});

test("bundled translations switch synchronously and React text interpolation does not double-escape", async () => {
  await i18n.changeLanguage("zh-CN");
  assert.equal(i18n.t("common:language"), "语言");
  i18n.addResourceBundle("en", "test", {
    greeting: "Hello {{name}}",
    count_one: "{{count}} task",
    count_other: "{{count}} tasks",
    fallback: "English fallback",
  });
  i18n.addResourceBundle("zh-CN", "test", {
    greeting: "你好，{{name}}",
    count_other: "{{count}} 个任务",
  });
  assert.equal(
    i18n.t("test:greeting", { name: "<Alice & Bob>" }),
    "你好，<Alice & Bob>",
  );
  assert.equal(i18n.t("test:count", { count: 2 }), "2 个任务");
  assert.equal(i18n.t("test:fallback"), "English fallback");
  await i18n.changeLanguage("en");
  assert.equal(i18n.t("test:count", { count: 1 }), "1 task");
  assert.equal(i18n.t("test:count", { count: 2 }), "2 tasks");
  i18n.removeResourceBundle("en", "test");
  i18n.removeResourceBundle("zh-CN", "test");
});

test("native menu and unsaved-edit dialog follow the selected interface language", () => {
  setNativeLanguage("zh-CN");
  assert.equal(nativeText("edit"), "编辑");
  assert.equal(nativeText("keepEditing"), "继续编辑");
  assert.equal(nativeText("leaveUnsaved"), "放弃未保存的文件编辑并离开？");
  setNativeLanguage("en");
  assert.equal(nativeText("edit"), "Edit");
});

test("literal UI translation calls resolve to catalog messages (including plural forms)", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const ts = await import("typescript");
  const root = new URL("../src/renderer/src/", import.meta.url);
  const missing: string[] = [];
  async function inspect(directory: URL): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "i18n") continue;
      const url = new URL(
        entry.name + (entry.isDirectory() ? "/" : ""),
        directory,
      );
      if (entry.isDirectory()) {
        await inspect(url);
        continue;
      }
      if (!/\.tsx?$/u.test(entry.name)) continue;
      const source = await readFile(url, "utf8");
      const namespace = source.match(/useTranslation\(["']([^"']+)["']/u)?.[1];
      const file = ts.createSourceFile(
        entry.name,
        source,
        ts.ScriptTarget.Latest,
        true,
        entry.name.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      function visit(node: import("typescript").Node): void {
        if (
          ts.isCallExpression(node) &&
          node.arguments[0] &&
          ts.isStringLiteral(node.arguments[0])
        ) {
          const isT =
            ts.isIdentifier(node.expression) && node.expression.text === "t";
          const isGlobalT =
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.getText(file) === "i18n.t";
          if (isT || isGlobalT) {
            const rawKey = node.arguments[0].text;
            const qualified = rawKey.includes(":")
              ? rawKey
              : `${namespace}:${rawKey}`;
            if (
              ![qualified, `${qualified}_one`, `${qualified}_other`].some(
                (key) => i18n.exists(key, { lng: "en" }),
              )
            )
              missing.push(`${entry.name}: ${qualified}`);
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(file);
    }
  }
  await inspect(root);
  assert.deepEqual(missing, []);
});
