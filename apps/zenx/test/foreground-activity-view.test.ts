import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  foregroundActivityHtml,
  foregroundActivityText,
  type ForegroundActivityViewOptions,
} from "../src/foreground-activity-view.js";

function view(overrides: Partial<ForegroundActivityViewOptions> = {}) {
  return new JSDOM(
    foregroundActivityHtml({
      kind: "status",
      agentNames: ["Ada"],
      stopping: false,
      language: "en",
      ...overrides,
    }),
  );
}

test("foreground status names the agent and exposes one keyboard-operable Stop action", () => {
  const dom = view();
  try {
    const document = dom.window.document;
    assert.equal(document.documentElement.lang, "en");
    assert.equal(document.querySelector(".agent-name")?.textContent, "Ada");
    assert.equal(
      document.querySelector(".activity-label")?.textContent,
      "is using your computer",
    );
    assert.equal(
      document.querySelector("#status")?.getAttribute("aria-live"),
      "polite",
    );
    assert.equal(
      document.querySelector("#status")?.getAttribute("aria-atomic"),
      "true",
    );
    const buttons = document.querySelectorAll("button");
    assert.equal(buttons.length, 1);
    const stop = buttons[0]!;
    assert.equal(stop.id, "stop");
    assert.equal(stop.type, "button");
    assert.equal(stop.disabled, false);
    assert.equal(stop.textContent, "Stop");
    assert.equal(
      stop.getAttribute("aria-label"),
      "Stop the displayed computer operations",
    );
    stop.focus();
    assert.equal(document.activeElement, stop);
    assert.equal(document.querySelector("[autofocus]"), null);
  } finally {
    dom.window.close();
  }
});

test("plain text projection matches the stable hooks used for safe native updates", () => {
  const options = {
    agentNames: ['Ada <&> "Lin"'],
    stopping: false,
    language: "en",
  } as const;
  const labels = foregroundActivityText(options);
  const dom = view(options);
  try {
    const document = dom.window.document;
    assert.equal(
      document.querySelector("#agent-names")?.textContent,
      labels.agentLabel,
    );
    assert.equal(
      document.querySelector("#activity-label")?.textContent,
      labels.activityLabel,
    );
    assert.equal(
      document.querySelector("#stop")?.textContent,
      labels.stopLabel,
    );
    assert.equal(
      document.querySelector("#stop")?.getAttribute("aria-label"),
      labels.stopDescription,
    );
    assert.equal(
      document.querySelector("#status")?.getAttribute("title"),
      labels.title,
    );
    assert.equal(
      document.querySelector("#status")?.getAttribute("data-stopping"),
      "false",
    );
  } finally {
    dom.window.close();
  }
});

test("foreground status localizes Chinese, multiple agents, and stop-request intent", () => {
  const dom = view({
    language: "zh-CN",
    agentNames: ["小舟", "林", "Ada", "Sam"],
    stopping: true,
  });
  try {
    const document = dom.window.document;
    assert.equal(document.documentElement.lang, "zh-CN");
    assert.equal(
      document.querySelector(".agent-name")?.textContent,
      "小舟 + 3",
    );
    assert.equal(
      document.querySelector(".activity-label")?.textContent,
      "正在停止电脑操作",
    );
    assert.match(
      document.querySelector("#status")!.getAttribute("title")!,
      /小舟、林、Ada 等 4 位 Agent/u,
    );
    const stop = document.querySelector<HTMLButtonElement>("#stop")!;
    assert.equal(stop.disabled, true);
    assert.equal(stop.getAttribute("aria-disabled"), "true");
    assert.equal(stop.textContent, "正在停止");
    assert.equal(
      document.querySelector("#status")?.getAttribute("data-stopping"),
      "true",
    );
    assert.doesNotMatch(document.body.textContent!, /已停止/u);
  } finally {
    dom.window.close();
  }
  const activeChinese = view({ language: "zh-CN" });
  const activeMultiple = view({ agentNames: ["Ada", "Lin"] });
  const stoppingEnglish = view({ stopping: true });
  try {
    assert.equal(
      activeChinese.window.document.querySelector(".activity-label")
        ?.textContent,
      "正在使用你的电脑",
    );
    assert.equal(
      activeChinese.window.document.querySelector("#stop")?.textContent,
      "停止",
    );
    assert.equal(
      activeMultiple.window.document.querySelector(".activity-label")
        ?.textContent,
      "are using your computer",
    );
    assert.equal(
      stoppingEnglish.window.document.querySelector("#stop")?.textContent,
      "Stopping…",
    );
  } finally {
    activeChinese.window.close();
    activeMultiple.window.close();
    stoppingEnglish.window.close();
  }
});

test("agent-controlled names cannot introduce markup, scripts, attributes, or bidi overrides", () => {
  const name =
    '\u202eAda <script>alert(1)</script> <img src=x onerror="alert(1)"> & \' friend';
  const dom = view({ agentNames: [name, '<svg onload="alert(2)">'] });
  try {
    const document = dom.window.document;
    assert.equal(
      document.querySelectorAll("script, img, iframe, a, input").length,
      0,
    );
    assert.equal(
      document.querySelectorAll("svg").length,
      1,
      "only the trusted presentation icon exists",
    );
    assert.equal(
      document.querySelectorAll("[onerror], [onload], [onclick]").length,
      0,
    );
    assert.ok(
      document.querySelector(".agent-name")?.textContent?.includes("<script>"),
    );
    assert.ok(
      document
        .querySelector("#status")
        ?.getAttribute("title")
        ?.includes('<svg onload="alert(2)">'),
    );
    assert.doesNotMatch(document.body.textContent!, /\u202e/u);
    assert.equal(document.querySelector(".agent-name")?.tagName, "BDI");
    const csp = document
      .querySelector('meta[http-equiv="Content-Security-Policy"]')!
      .getAttribute("content")!;
    assert.match(csp, /default-src 'none'/u);
    assert.match(csp, /script-src 'none'/u);
    assert.match(csp, /base-uri 'none'/u);
    assert.match(csp, /form-action 'none'/u);
  } finally {
    dom.window.close();
  }
});

test("untrusted names have bounded Unicode-safe presentation and a nonempty fallback", () => {
  const long = view({
    agentNames: ["🦉".repeat(1000)],
  });
  const many = view({
    agentNames: Array.from(
      { length: 100 },
      (_, index) => `${index} ${"🦉".repeat(1000)}`,
    ),
  });
  const empty = view({ agentNames: [] });
  const whitespace = view({ agentNames: ["\n\t "] });
  try {
    const label =
      long.window.document.querySelector(".agent-name")!.textContent!;
    assert.equal(label, `${"🦉".repeat(79)}…`);
    assert.ok(
      Array.from(
        many.window.document.querySelector("#status")!.getAttribute("title")!,
      ).length < 300,
    );
    assert.equal(
      empty.window.document.querySelector(".agent-name")?.textContent,
      "Agent",
    );
    assert.equal(
      whitespace.window.document.querySelector(".agent-name")?.textContent,
      "Agent",
    );
  } finally {
    long.window.close();
    many.window.close();
    empty.window.close();
    whitespace.window.close();
  }
});

test("edge-only rendering is decorative, transparent, noninteractive, and motion-safe", () => {
  const dom = view({ kind: "edges", stopping: true });
  try {
    const document = dom.window.document;
    assert.equal(
      document.querySelector(".edge-frame")?.getAttribute("aria-hidden"),
      "true",
    );
    assert.equal(document.querySelector("button, #status, script"), null);
    const css = document.querySelector("style")!.textContent!;
    assert.match(css, /background: transparent/u);
    assert.match(css, /pointer-events: none/u);
    assert.match(
      css,
      /\.edge-frame\[data-stopping="true"\]::after \{ animation: none;/u,
    );
    assert.match(css, /prefers-reduced-motion: reduce/u);
    assert.match(
      css,
      /animation: none !important; transition: none !important;/u,
    );
    assert.match(css, /forced-colors: active/u);
    assert.match(css, /border: 2px solid Highlight/u);
    assert.match(css, /#stop:focus-visible/u);
    assert.match(css, /height: 44px/u);
    assert.match(css, /max-width: 380px/u);
  } finally {
    dom.window.close();
  }
});

test("inspectable preview imports the production renderer instead of copying overlay markup", () => {
  const preview = readFileSync(
    new URL("./fixtures/foreground-activity-visual.ts", import.meta.url),
    "utf8",
  );
  const html = readFileSync(
    new URL("./fixtures/foreground-activity-visual.html", import.meta.url),
    "utf8",
  );
  assert.match(
    preview,
    /from "\.\.\/\.\.\/src\/foreground-activity-view\.js"/u,
  );
  assert.match(preview, /foregroundActivityHtml\(/u);
  assert.doesNotMatch(html, /id="stop"|class="edge-frame"/u);
});

test("multiple calls for the same normalized agent do not inflate the agent count", () => {
  const sameAgent = foregroundActivityText({
    agentNames: [" Ada ", "Ada", "\u202eAda"],
    language: "en",
    stopping: false,
  });
  assert.equal(sameAgent.agentLabel, "Ada");
  assert.equal(sameAgent.activityLabel, "is using your computer");
  const twoAgents = foregroundActivityText({
    agentNames: ["Ada", "Ada", "Lin", "Lin"],
    language: "zh-CN",
    stopping: false,
  });
  assert.equal(twoAgents.agentLabel, "Ada + 1");
  assert.equal(twoAgents.title, "Ada、Lin 正在使用你的电脑");
});

test("Escape copy states only confirmed shortcut availability in both languages", () => {
  for (const language of ["en", "zh-CN"] as const) {
    const common = {
      kind: "status" as const,
      agentNames: ["ZenX Agent"],
      stopping: false,
      language,
    };
    const available = foregroundActivityHtml({
      ...common,
      escapeAvailable: true,
    });
    const unavailable = foregroundActivityHtml({
      ...common,
      escapeAvailable: false,
    });
    assert.match(
      available,
      language === "en" ? /Press Esc to stop/ : /按 Esc 停止操作/,
    );
    assert.match(
      unavailable,
      language === "en" ? /Esc unavailable/ : /Esc 不可用/,
    );
    assert.doesNotMatch(
      unavailable,
      language === "en" ? /Press Esc to stop/ : /按 Esc 停止操作/,
    );
  }
});

test("foreground status identifies the admitted action without exposing typed content", () => {
  const english = view({ actions: ["type"] });
  const chinese = view({ language: "zh-CN", actions: ["scroll"] });
  try {
    assert.equal(
      english.window.document.querySelector("#action-detail")?.textContent,
      "Typing · current foreground app",
    );
    assert.equal(
      chinese.window.document.querySelector("#action-detail")?.textContent,
      "滚动 · 当前前台应用",
    );
  } finally {
    english.window.close();
    chinese.window.close();
  }
});
