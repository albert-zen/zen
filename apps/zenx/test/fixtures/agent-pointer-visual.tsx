import React from "react";
import { createRoot } from "react-dom/client";
import { ComputerThreadPanel } from "../../src/renderer/src/computer-thread-panel.js";
import type { ComputerThreadEvent } from "../../src/main/capabilities/computer-thread-observation.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";

document.documentElement.dataset.appearance = location.search.includes("dark")
  ? "dark"
  : "light";
const canvas = document.createElement("canvas");
canvas.width = 800;
canvas.height = 600;
const context = canvas.getContext("2d")!;
context.fillStyle = "#f4f5f7";
context.fillRect(0, 0, 800, 600);
context.fillStyle = "#20252f";
context.font = "600 26px system-ui";
context.fillText("Sample window", 38, 64);
context.font = "18px system-ui";
context.fillText("Visual fixture · no desktop input", 38, 103);
for (const [index, text] of [
  "Project name",
  "Description",
  "Save changes",
].entries()) {
  context.fillStyle = index === 2 ? "#d8e9ff" : "#ffffff";
  context.fillRect(40, 155 + index * 115, 720, 65);
  context.fillStyle = "#26364e";
  context.fillText(text, 65, 194 + index * 115);
}
Object.defineProperty(window, "zenx", {
  value: {
    computerObservation: {
      subscribe(
        _request: unknown,
        listener: (event: ComputerThreadEvent) => void,
      ) {
        let sequence = 0;
        const tick = () => {
          const now = new Date().toISOString();
          const index = sequence++ % 3;
          listener({
            type: "targets",
            selectedId: "fixture-window",
            targets: [
              {
                id: "fixture-window",
                invocationId: `fixture-${sequence}`,
                mode: "live",
                target: { pid: 1, windowTitle: "Sample window" },
                pointer: {
                  x: 0.35 + index * 0.1,
                  y: (185 + index * 115) / 600,
                  action: index === 2 ? "press" : "set_value",
                  capturedAt: now,
                  windowWidth: 800,
                  windowHeight: 600,
                },
              },
            ],
          });
          listener({
            type: "status",
            status: "live",
            message: "Live window view · visual fixture",
          });
          listener({
            type: "frame",
            frame: {
              sequence,
              mimeType: "image/jpeg",
              data: canvas.toDataURL("image/jpeg").split(",")[1]!,
              width: 800,
              height: 600,
              capturedAt: now,
            },
          });
        };
        tick();
        const timer = setInterval(tick, 850);
        return () => clearInterval(timer);
      },
    },
  },
});
createRoot(document.getElementById("root")!).render(
  <main style={{ height: "100vh", maxWidth: 900, margin: "auto" }}>
    <ComputerThreadPanel threadId="visual-fixture" active />
  </main>,
);
