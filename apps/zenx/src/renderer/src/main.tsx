import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { getAppearanceController } from "./appearance";
import { installScrollbarVisibility } from "./scrollbar-visibility";
import "./theme.css";
import "./styles.css";
import "./agent-readiness-notice.css";
import "./trigger-ui.css";
import "./skills.css";

getAppearanceController();
const disposeScrollbars = installScrollbarVisibility(document);
import.meta.hot?.dispose(disposeScrollbars);

document.documentElement.dataset.platform = navigator.userAgent.includes(
  "Macintosh",
)
  ? "darwin"
  : navigator.userAgent.includes("Windows")
    ? "win32"
    : "linux";

const root = document.getElementById("root");

if (!root) throw new Error("ZenX renderer root is missing");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
