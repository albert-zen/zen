import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { getAppearanceController } from "./appearance";
import "./styles.css";

getAppearanceController();

const root = document.getElementById("root");

if (!root) throw new Error("ZenX renderer root is missing");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
