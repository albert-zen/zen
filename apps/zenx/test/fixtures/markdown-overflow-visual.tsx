import React from "react";
import { createRoot } from "react-dom/client";
import { Markdown } from "../../src/renderer/src/Markdown.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";

Object.assign(globalThis, { React });
const token = "long_identifier_".repeat(24);
const prose = `中文长内容与无空格标识符 ${token}\n\nhttps://example.com/${token}\n\n\`${token}\`\n\n# ${token}\n\n- ${token}\n\n> ${token}`;
const code = `const value = "${token}";`;
const text = `${prose}\n\n\`\`\`js\n${code}\n\`\`\``;

createRoot(document.getElementById("root")!).render(
  <main style={{ padding: 24, maxWidth: 900, margin: "auto" }}>
    <section className="turn">
      <div className="user-row">
        <div className="user-bubble">
          <Markdown text={text} />
        </div>
      </div>
      <div className="agent-copy">
        <Markdown text={text} />
      </div>
      <div className="trace-detail trace-detail-markdown">
        <Markdown text={text} />
      </div>
      <div className="agent-copy">
        <Markdown text={`Streaming\n\n\`\`\`js\n${code}`} />
      </div>
    </section>
  </main>,
);
