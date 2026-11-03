import React from "react";
import { createRoot } from "react-dom/client";
import { PendingSendRows } from "../../src/renderer/src/PendingSendRows.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";

document.documentElement.dataset.appearance = "light";
document.documentElement.dataset.platform = "linux";
void i18n.changeLanguage("zh-CN");
const text = "之后晚上你可以自己调整轮询时间，比如改成每两小时一次。";
createRoot(document.getElementById("root")!).render(
  <div className="messages-inner" style={{ padding: 24 }}>
    <PendingSendRows
      messages={[
        {
          clientId: "synthetic",
          intent: "start",
          status: "sending",
          error: null,
          draft: { text, images: [] },
        },
      ]}
    />
    <article className="user-row" data-settled="true">
      <div className="user-bubble">
        <div className="markdown-body">
          <p>{text}</p>
        </div>
      </div>
    </article>
  </div>,
);
