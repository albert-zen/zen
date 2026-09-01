import React from "react";
import { createRoot } from "react-dom/client";

import type { BrowserLiveObservationEvent } from "../../src/main/capabilities/browser-provider.js";
import { BrowserPage } from "../../src/renderer/src/bundled-browser-ui.js";
import { Icon } from "../../src/renderer/src/icons.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";

const appearance = new URLSearchParams(location.search).get("appearance");
const frameDelay = Number(
  new URLSearchParams(location.search).get("frameDelay") ?? "0",
);
document.documentElement.dataset.appearance =
  appearance === "light" ? "light" : "dark";

Object.defineProperty(window, "zenx", {
  value: {
    browserObservation: {
      subscribe(listener: (event: BrowserLiveObservationEvent) => void) {
        let active = true;
        listener({
          type: "status",
          status: "connecting",
          message: "Connecting to the Agent's browser tab…",
        });
        const image =
          appearance === "light"
            ? "/docs/assets/appearance/zenx-light-thread.jpg"
            : "/docs/assets/appearance/zenx-dark-thread.jpg";
        window.setTimeout(
          () => {
            void fetch(image)
              .then(async (response) => await response.blob())
              .then((blob) => {
                const reader = new FileReader();
                reader.addEventListener("load", () => {
                  if (!active || typeof reader.result !== "string") return;
                  listener({
                    type: "status",
                    status: "live",
                    message: "Watching the Agent's browser tab live.",
                  });
                  listener({
                    type: "frame",
                    frame: {
                      sequence: 1,
                      mimeType: "image/jpeg",
                      data: reader.result.split(",")[1] ?? "",
                      width: 1600,
                      height: 1000,
                    },
                  });
                });
                reader.readAsDataURL(blob);
              });
          },
          Number.isFinite(frameDelay) ? Math.max(0, frameDelay) : 0,
        );
        return () => {
          active = false;
        };
      },
    },
  },
});

function Harness() {
  return (
    <main className="product-page plugin-product-page">
      <header className="page-header">
        <div className="page-title">
          <button className="icon-button mobile-menu" aria-label="Open sidebar">
            <Icon name="tree" />
          </button>
          <div>
            <h1>Browser</h1>
            <p>Provided by browser</p>
          </div>
        </div>
      </header>
      <div className="page-scroll plugin-page-scroll">
        <section className="plugin-primary-surface">
          <BrowserPage />
        </section>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
