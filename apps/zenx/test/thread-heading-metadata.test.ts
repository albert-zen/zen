import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import ts from "typescript";
import { i18n } from "../src/renderer/src/i18n.js";

const rendererRoot = new URL("../src/renderer/src/", import.meta.url);
const app = await readFile(new URL("App.tsx", rendererRoot), "utf8");
const styles = await readFile(new URL("styles.css", rendererRoot), "utf8");
const parsed = ts.createSourceFile(
  "App.tsx",
  app,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const declaration = parsed.statements.find(
  (node) =>
    ts.isFunctionDeclaration(node) &&
    node.name?.text === "ConversationTitleBar",
)!;
// Exercise the actual header without mounting the App's unrelated host services.
const Header = new Function(
  "React",
  "i18n",
  "Icon",
  "ThreadBreadcrumbAncestors",
  "ThreadTitleEditor",
  "threadTitle",
  "threadEditTitle",
  `${
    ts.transpileModule(declaration.getText(parsed), {
      compilerOptions: {
        jsx: ts.JsxEmit.React,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText
  }; return ConversationTitleBar;`,
)(
  React,
  i18n,
  () => null,
  () => React.createElement("nav", { "data-breadcrumbs": true }),
  ({ title }: { title: string }) => React.createElement("strong", null, title),
  (summary: { title: string }) => summary.title,
  (summary: { title: string }) => summary.title,
);

const cwd = `/workspace/${"long-directory/".repeat(30)}project`;
const title = `Custom source · / not a route ${"long label ".repeat(30)}`;
function header(overrides: Record<string, unknown> = {}) {
  return Header({
    threads: [],
    onNavigate() {},
    onOpenSidebar() {},
    onRename() {},
    onRetryTitle() {},
    onOpenSource() {},
    selectedSummary: {
      threadId: "copy",
      title: "Custom copy",
      status: "idle",
      currentMetadata: { cwd },
    },
    sourceSummary: { threadId: "exact-source-id", title },
    threadDetail: { forkedFromId: "exact-source-id" },
    ...overrides,
  }) as React.ReactElement;
}
function findElement(
  node: React.ReactNode,
  className: string,
): React.ReactElement<Record<string, unknown>> | undefined {
  if (!React.isValidElement<Record<string, unknown>>(node)) return;
  if (String(node.props.className).split(" ").includes(className)) return node;
  for (const child of React.Children.toArray(
    node.props.children as React.ReactNode,
  )) {
    const found = findElement(child, className);
    if (found) return found;
  }
}

test("long cwd and custom source labels are separate bounded siblings with full labels and exact navigation", async () => {
  await i18n.changeLanguage("en");
  let opened = "";
  const tree = header({
    onOpenSource: (id: string) => {
      opened = id;
    },
  });
  const dom = new JSDOM(renderToStaticMarkup(tree));
  const row = dom.window.document.querySelector(".thread-heading-metadata")!;
  assert.equal(row.children.length, 2);
  const [cwdLabel, source] = row.children;
  assert.ok(cwdLabel);
  assert.ok(source);
  assert.equal(cwdLabel.className, "thread-heading-cwd");
  assert.equal(cwdLabel.textContent, cwd);
  assert.equal(cwdLabel.getAttribute("title"), cwd);
  assert.equal(source.tagName, "BUTTON");
  assert.equal(source.textContent, `Copied from ${title}`);
  assert.equal(source.getAttribute("title"), source.textContent);
  assert.ok(dom.window.document.querySelector("[data-breadcrumbs]"));
  assert.equal(
    dom.window.document.querySelector("strong")!.textContent,
    "Custom copy",
  );
  (findElement(tree, "thread-source-link")!.props.onClick as () => void)();
  assert.equal(opened, "exact-source-id");
  dom.window.close();
});

test("ordinary, unavailable, system-error and localized metadata preserve existing states", async () => {
  for (const language of ["en", "zh"]) {
    await i18n.changeLanguage(language);
    for (const threadDetail of [null, { forkedFromId: null }, {}]) {
      const tree = header({ threadDetail });
      assert.equal(findElement(tree, "thread-heading-source"), undefined);
      assert.equal(
        findElement(tree, "thread-heading-cwd")!.props.children,
        cwd,
      );
    }
    const unavailable = findElement(
      header({ sourceSummary: undefined }),
      "thread-heading-source",
    )!;
    assert.equal(unavailable.type, "span");
    assert.equal(
      unavailable.props.children,
      i18n.t("shell:copiedFromUnavailableSource"),
    );
    assert.equal(unavailable.props.title, unavailable.props.children);
    assert.equal(unavailable.props.onClick, undefined);
    const error = header({
      selectedSummary: {
        threadId: "copy",
        title: "Custom copy",
        status: "systemError",
        currentMetadata: { cwd },
      },
    });
    assert.equal(
      findElement(error, "thread-heading-cwd")!.props.children,
      i18n.t("shell:unavailableJournal"),
    );
    assert.equal(
      findElement(error, "thread-heading-cwd")!.props.title,
      i18n.t("shell:unavailableJournal"),
    );
    assert.equal(
      findElement(error, "thread-source-link")!.props.children,
      i18n.t("shell:copiedFrom", { name: title }),
    );
  }
  await i18n.changeLanguage("en");
});

test("metadata clips each label, never the shared row, and reserves bounded source space at every allocation", () => {
  assert.match(
    styles,
    /\.thread-heading-metadata\s*\{[^}]*min-width: 0;[^}]*display: flex;[^}]*gap: 8px;/su,
  );
  assert.doesNotMatch(
    styles,
    /\.thread-heading-metadata\s*\{[^}]*(?:overflow: hidden|white-space: nowrap)/su,
  );
  assert.match(
    styles,
    /\.thread-heading-cwd,\s*\.thread-heading-source\s*\{[^}]*min-width: 0;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/su,
  );
  assert.match(styles, /\.thread-heading-cwd\s*\{[^}]*flex: 1 1 auto;/su);
  assert.match(
    styles,
    /\.thread-heading-source\s*\{[^}]*flex: 0 0 auto;[^}]*max-width: 60%;/su,
  );
  assert.match(
    styles,
    /\.workspace-header button,[\s\S]*?-webkit-app-region: no-drag;/u,
  );
  assert.match(styles, /\.thread-source-link:focus-visible\s*\{/u);
});
