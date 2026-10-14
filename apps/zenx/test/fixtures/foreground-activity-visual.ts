import {
  foregroundActivityHtml,
  type ForegroundActivityViewOptions,
} from "../../src/foreground-activity-view.js";

// Serve from the repository root with Vite, then open this HTML fixture.
// Query options: language=en, agents=long|multiple, theme=light, stopping=1.
const query = new URLSearchParams(location.search);
const language = document.querySelector<HTMLSelectElement>("#language")!;
const agents = document.querySelector<HTMLSelectElement>("#agents")!;
const edges = document.querySelector<HTMLIFrameElement>("#edge-preview")!;
const status = document.querySelector<HTMLIFrameElement>("#status-preview")!;
const theme = document.querySelector<HTMLButtonElement>("#theme")!;
let stopping = query.get("stopping") === "1";
language.value = query.get("language") === "en" ? "en" : "zh-CN";
agents.value = ["long", "multiple"].includes(query.get("agents") ?? "")
  ? query.get("agents")!
  : "single";
document.documentElement.dataset.theme =
  query.get("theme") === "light" ? "light" : "dark";

function render() {
  const chinese = language.value === "zh-CN";
  const options: Omit<ForegroundActivityViewOptions, "kind"> = {
    language: chinese ? "zh-CN" : "en",
    stopping,
    agentNames:
      agents.value === "multiple"
        ? ["PAW", chinese ? "小舟" : "Ada", "Lin"]
        : agents.value === "long"
          ? [
              chinese
                ? "小舟 · 这是一个很长很长的个人助手名称"
                : "Alexandria · a very long personal assistant name",
            ]
          : ["PAW"],
  };
  edges.srcdoc = foregroundActivityHtml({ ...options, kind: "edges" });
  status.srcdoc = foregroundActivityHtml({ ...options, kind: "status" });
  document.documentElement.lang = chinese ? "zh-CN" : "en";
  document.title = chinese
    ? "前台电脑操作提示预览"
    : "Foreground computer activity preview";
  const labels = chinese
    ? {
        eyebrow: "ZenX · 前台操作提示",
        "preview-heading": "轻一点提示，随时可以停止。",
        "preview-description":
          "屏幕边缘的轻光效提示正在进行的电脑操作。顶部显示助手名称，保留清晰的停止入口。",
        "workspace-label": "试着在这里输入。预览中的边缘光效不拦截点击。",
        "language-label": "语言",
        "agents-label": "助手",
        resume: "重置预览",
        "preview-note":
          "实际组件的视觉预览，不执行电脑操作。原生窗口的焦点与点击穿透仍需另行验证。",
      }
    : {
        eyebrow: "ZenX · Foreground activity",
        "preview-heading": "A quiet signal. A clear way to stop.",
        "preview-description":
          "The screen edge marks active computer use. The compact status names the agent and keeps Stop within reach.",
        "workspace-label":
          "Try typing here. The preview edge does not capture clicks.",
        "language-label": "Language",
        "agents-label": "Agents",
        resume: "Reset preview",
        "preview-note":
          "Production component preview; no desktop input. Native focus and pointer pass-through need separate verification.",
      };
  for (const [id, text] of Object.entries(labels))
    document.getElementById(id)!.textContent = text;
  for (const [index, label] of (chinese
    ? ["单个助手", "多个助手", "长名称"]
    : ["One agent", "Multiple agents", "Long name"]
  ).entries())
    agents.options[index]!.textContent = label;
  edges.title = chinese ? "屏幕边缘光效预览" : "Decorative screen edge preview";
  status.title = chinese
    ? "电脑操作状态预览"
    : "Computer activity status preview";
  document
    .querySelector(".controls")!
    .setAttribute(
      "aria-label",
      chinese ? "预览选项" : "Visual preview options",
    );
  theme.textContent =
    document.documentElement.dataset.theme === "dark"
      ? chinese
        ? "浅色背景"
        : "Light background"
      : chinese
        ? "深色背景"
        : "Dark background";
}

// The native window binds this button in its sandboxed preload. The fixture
// explicitly simulates only the visible stop-request state, with no native bridge.
status.addEventListener("load", () => {
  status.contentDocument
    ?.querySelector("#stop")
    ?.addEventListener("click", () => {
      stopping = true;
      render();
    });
});
language.addEventListener("change", render);
agents.addEventListener("change", render);
theme.addEventListener("click", () => {
  document.documentElement.dataset.theme =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  render();
});
document.querySelector("#resume")!.addEventListener("click", () => {
  stopping = false;
  render();
});
render();
