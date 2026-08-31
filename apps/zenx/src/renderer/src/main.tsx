import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { getAppearanceController } from "./appearance";
import "./theme.css";
import "./styles.css";

getAppearanceController();

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
