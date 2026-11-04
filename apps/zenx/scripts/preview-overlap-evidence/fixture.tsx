import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ImageUrlPreview } from "../../src/renderer/src/ImagePresentation.js";
import { WorkspaceBrowserPanel } from "../../src/renderer/src/workspace-browser-panel.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import "../../src/renderer/src/styles.css";
import "../../src/renderer/src/theme.css";
import "./fixture.css";
const image =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="#ffdc00"/><text x="60" y="100" font-size="40">Owned synthetic image preview</text></svg>',
  );
function Fixture() {
  const [count, setCount] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  (window as any).__overlayEvidence = { setCount, count };
  return (
    <>
      <main className="evidence-main">
        <h1>ZenX native overlap regression</h1>
        <p>
          Production image preview and native browser panel. Synthetic owned
          content.
        </p>
        <button ref={trigger} id="open-preview" onClick={() => setCount(1)}>
          Open image preview
        </button>
      </main>
      <aside className="evidence-browser">
        <WorkspaceBrowserPanel
          threadId="evidence-thread"
          open={true}
          tab={(window as any).__evidenceTab}
        />
      </aside>
      {Array.from({ length: count }, (_, index) => (
        <ImageUrlPreview
          key={index}
          name={`Owned image ${index + 1}`}
          url={image}
          error={null}
          onClose={() => setCount(0)}
          trigger={trigger.current!}
        />
      ))}
    </>
  );
}
void i18n
  .changeLanguage("en")
  .then(() => createRoot(document.getElementById("root")!).render(<Fixture />));
