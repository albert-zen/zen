import React from "react";
import { createRoot } from "react-dom/client";

import { AgentWorkspace } from "./workspace";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AgentWorkspace />
  </React.StrictMode>
);
