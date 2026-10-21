// Real controls, synthetic data, no Host or network connection.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ContextUsageIndicator } from "../../src/renderer/src/ThreadView.js";
import { ComposerSendControl } from "../../src/renderer/src/ComposerSendControl.js";
import type { ComposerSendMode } from "../../src/renderer/src/composer-state.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";

const options = new URLSearchParams(location.search);
const initialTheme = options.get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.appearance = initialTheme;
document.documentElement.dataset.platform = "darwin";
void i18n.changeLanguage(options.get("lang") === "zh-CN" ? "zh-CN" : "en");

function Fixture() {
  const [theme, setTheme] = useState(initialTheme);
  const [placement, setPlacement] = useState(
    options.get("placement") === "below" ? "below" : "above",
  );
  const [pressure, setPressure] = useState(false);
  const [mode, setMode] = useState<ComposerSendMode>("soft");
  const [action, setAction] = useState("No action");
  const variant = document.body.dataset.variant ?? "after";
  return (
    <main className="thread-view motion-preview-page">
      <header>
        <h2>{variant === "before" ? "Before" : "After"}</h2>
        <p>Hover the ring, then Send. Tab, Escape, press, and cross the gap.</p>
        <div className="motion-preview-options">
          <button
            type="button"
            onClick={() => {
              const next = theme === "light" ? "dark" : "light";
              document.documentElement.dataset.appearance = next;
              setTheme(next);
            }}
          >
            {theme === "light" ? "Dark" : "Light"} theme
          </button>
          <button
            type="button"
            onClick={() =>
              setPlacement(placement === "above" ? "below" : "above")
            }
          >
            Place panel {placement === "above" ? "below" : "above"}
          </button>
          <button
            type="button"
            aria-pressed={pressure}
            onClick={() => setPressure(!pressure)}
          >
            {pressure ? "Normal usage" : "Over capacity"}
          </button>
        </div>
      </header>
      <section className="motion-preview-stage" data-placement={placement}>
        <div className="motion-preview-controls composer">
          <div>
            <ContextUsageIndicator
              context={{
                inputTokens: pressure ? 587500 : 51300,
                inputTokenSource: "provider",
                contextWindow: 272000,
                ratio: (pressure ? 587500 : 51300) / 272000,
              }}
              threadCacheHitRate={0.93}
              threadOutputRate={42}
              onCompact={async () => setAction("Compact clicked")}
            />
            <span>Context</span>
          </div>
          <div>
            <ComposerSendControl
              mode={mode}
              running={true}
              hasDraft={true}
              disabled={false}
              sendDisabled={false}
              primaryMode="send"
              primaryLabel="Send"
              compact={false}
              onPrimary={() => setAction("Send clicked")}
              onSend={(intent) => setAction(`Send: ${intent}`)}
              onStop={() => setAction("Stop clicked")}
              onModeChange={async (value) => setMode(value)}
            />
            <span>Send (unchanged)</span>
          </div>
        </div>
      </section>
      <footer>
        <output aria-live="polite">{action}</output>
        <p>
          Reduced motion follows your OS/browser preference. The context
          percentage and arc never change on hover.
        </p>
      </footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
