export interface ForegroundActivityViewOptions {
  kind: "edges" | "status";
  agentNames: readonly string[];
  stopping: boolean;
  language: "en" | "zh-CN";
}

const style = `
  :root {
    color-scheme: dark;
    font-family: "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif;
    font-synthesis: none;
    text-rendering: optimizeLegibility;
    -webkit-font-smoothing: antialiased;
  }
  *, *::before, *::after { box-sizing: border-box; }
  html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
  body { user-select: none; }
  .edge-frame {
    position: fixed;
    inset: 0;
    border: 2px solid rgb(135 158 255 / 64%);
    border-radius: 10px;
    box-shadow: inset 0 0 3px rgb(185 205 255 / 65%), inset 0 0 18px rgb(103 127 255 / 28%);
    pointer-events: none;
  }
  .edge-frame::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow: inset 0 0 28px rgb(123 105 235 / 22%);
    animation: edge-breathe 4.8s ease-in-out infinite;
  }
  .status-body { display: flex; justify-content: center; align-items: center; padding: 6px 8px; }
  #status {
    display: flex;
    align-items: center;
    gap: 10px;
    width: max-content;
    max-width: 100%;
    height: 52px;
    padding: 3px 4px 3px 15px;
    border: 1px solid rgb(191 203 255 / 24%);
    border-radius: 17px;
    background: #20232c;
    color: #f4f5f8;
    box-shadow: 0 2px 5px rgb(0 0 0 / 22%), inset 0 1px 0 rgb(255 255 255 / 4%);
  }
  .activity-icon { flex: 0 0 18px; width: 18px; height: 18px; color: #b3c2ff; }
  .message { display: flex; align-items: baseline; gap: 4px; min-width: 0; font-size: 13px; line-height: 18px; }
  .agent-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  .activity-label { flex-shrink: 0; color: #c8cbd5; white-space: nowrap; }
  #stop {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    flex: 0 0 auto;
    height: 44px;
    min-width: 66px;
    padding: 0 10px;
    border: 1px solid transparent;
    border-radius: 12px;
    background: #363b48;
    color: #f4f5f8;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background-color 100ms ease, border-color 100ms ease;
    -webkit-app-region: no-drag;
  }
  #stop::before { content: ""; width: 7px; height: 7px; border-radius: 1.5px; background: currentColor; }
  #stop:hover:not(:disabled) { background: #474e5e; border-color: rgb(209 217 249 / 25%); }
  #stop:active:not(:disabled) { background: #292e3a; }
  #stop:focus-visible { outline: 2px solid #b3c2ff; outline-offset: -3px; }
  #stop:disabled { background: #2c303a; color: #b8bdca; cursor: default; }
  #stop:disabled::before { display: none; }
  .edge-frame[data-stopping="true"]::after { animation: none; }
  #status[data-stopping="true"] .activity-icon { color: #bdc2d0; }
  @keyframes edge-breathe { 0%, 100% { opacity: .4; } 50% { opacity: 1; } }
  @media (max-width: 380px) {
    #status { gap: 8px; padding-left: 11px; border-radius: 15px; }
    .message { display: block; }
    .agent-name { display: block; }
    .activity-label { display: block; font-size: 11px; line-height: 15px; }
    #stop { min-width: 60px; padding: 0 8px; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
  }
  @media (forced-colors: active) {
    :root { color-scheme: light dark; }
    .edge-frame { border: 2px solid Highlight; box-shadow: none; }
    .edge-frame::after { display: none; }
    #status { background: Canvas; color: CanvasText; border: 1px solid CanvasText; box-shadow: none; }
    .activity-icon, #status[data-stopping="true"] .activity-icon, .activity-label { color: CanvasText; }
    #stop, #stop:hover:not(:disabled), #stop:active:not(:disabled) { background: ButtonFace; color: ButtonText; border-color: ButtonText; }
    #stop:disabled { background: ButtonFace; color: GrayText; border-color: GrayText; }
    #stop:focus-visible { outline-color: Highlight; }
  }
`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function safeName(value: string | undefined): string {
  const clean = (value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "")
    .trim();
  const characters = Array.from(clean);
  return characters.length > 80
    ? `${characters.slice(0, 79).join("")}…`
    : clean || "Agent";
}

/** Bounded plain text for initial markup and textContent-only native preload updates. */
export function foregroundActivityText(
  options: Pick<
    ForegroundActivityViewOptions,
    "agentNames" | "stopping" | "language"
  >,
): {
  agentLabel: string;
  activityLabel: string;
  stopLabel: string;
  stopDescription: string;
  title: string;
} {
  const chinese = options.language === "zh-CN";
  const uniqueNames = [...new Set(options.agentNames.map(safeName))];
  const otherCount = Math.max(0, uniqueNames.length - 1);
  const firstName = uniqueNames[0] ?? "Agent";
  const visibleNames = otherCount ? `${firstName} + ${otherCount}` : firstName;
  const namedAgents = uniqueNames.slice(0, 3);
  const moreCount = Math.max(0, uniqueNames.length - namedAgents.length);
  const titleNames =
    (namedAgents.join(chinese ? "、" : ", ") || firstName) +
    (moreCount
      ? chinese
        ? ` 等 ${uniqueNames.length} 位 Agent`
        : ` and ${moreCount} more`
      : "");
  const activity = options.stopping
    ? chinese
      ? "正在停止电脑操作"
      : "Stopping computer use…"
    : chinese
      ? "正在使用你的电脑"
      : otherCount
        ? "are using your computer"
        : "is using your computer";
  const title = `${titleNames} ${activity}`;
  const stopLabel = options.stopping
    ? chinese
      ? "正在停止"
      : "Stopping…"
    : chinese
      ? "停止"
      : "Stop";
  const stopDescription = chinese
    ? "停止显示中的电脑操作"
    : "Stop the displayed computer operations";
  return {
    agentLabel: visibleNames,
    activityLabel: activity,
    stopLabel,
    stopDescription: options.stopping ? stopLabel : stopDescription,
    title,
  };
}

/** Script-free presentation shared by the isolated native windows and visual fixture. */
export function foregroundActivityHtml(
  options: ForegroundActivityViewOptions,
): string {
  const chinese = options.language === "zh-CN";
  const { agentLabel, activityLabel, stopLabel, stopDescription, title } =
    foregroundActivityText(options);
  const content =
    options.kind === "edges"
      ? `<div id="edges" class="edge-frame" data-stopping="${options.stopping}" aria-hidden="true"></div>`
      : `<div id="status" data-stopping="${options.stopping}" role="status" aria-live="polite" aria-atomic="true" title="${escapeHtml(title)}">
  <svg class="activity-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="2.5" y="3.5" width="15" height="10.5" rx="2"/><path d="M7 17h6m-3-3v3m-4-9h3m-3 3h6"/></svg>
  <span class="message"><bdi id="agent-names" class="agent-name" dir="auto">${escapeHtml(agentLabel)}</bdi><span id="activity-label" class="activity-label">${escapeHtml(activityLabel)}</span></span>
  <button id="stop" type="button" aria-label="${escapeHtml(stopDescription)}"${options.stopping ? ' disabled aria-disabled="true"' : ""}>${escapeHtml(stopLabel)}</button>
</div>`;

  return `<!doctype html>
<html lang="${options.language}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(chinese ? "电脑操作状态" : "Computer activity")}</title>
  <style>${style}</style>
</head>
<body class="${options.kind === "status" ? "status-body" : "edges-body"}">${content}</body>
</html>`;
}
