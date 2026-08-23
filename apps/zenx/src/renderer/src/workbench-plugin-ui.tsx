import { useState } from "react";

import type { PluginUiModule, PluginUiSurfaceProps } from "./plugin-ui-host.js";

function Overview({ sdk }: PluginUiSurfaceProps) {
  const [reply, setReply] = useState("Ready");
  return (
    <div className="workbench-card">
      <p className="eyebrow">Plugin UI SDK v{sdk.version}</p>
      <h2>Workbench</h2>
      <p>A generic bundled surface mounted inside the ZenX workspace.</p>
      <div className="plugin-action-row">
        <button
          type="button"
          onClick={() =>
            sdk.navigation.navigate("/plugins/workbench/home/details")
          }
        >
          Open details
        </button>
        <button
          type="button"
          onClick={() => {
            void sdk.commands.execute("refresh").then((value) => {
              const result = value as { result?: { ok?: boolean } };
              setReply(result.result?.ok === true ? "Refreshed" : "Completed");
            });
          }}
        >
          Refresh
        </button>
      </div>
      <p role="status">{reply}</p>
    </div>
  );
}

function Details({ sdk }: PluginUiSurfaceProps) {
  return (
    <div className="workbench-card">
      <p className="eyebrow">Subroute</p>
      <h2>Workbench details</h2>
      <p>Theme from the shared UI SDK: {sdk.theme}</p>
      <button
        type="button"
        onClick={() => sdk.navigation.navigate("/plugins/workbench/home")}
      >
        Back to overview
      </button>
    </div>
  );
}

function Preferences({ sdk }: PluginUiSurfaceProps) {
  return (
    <div className="workbench-card">
      <h3>Workbench preferences</h3>
      <p>Host context handle: {String(sdk.context.handleId)}</p>
    </div>
  );
}

function Status() {
  return (
    <div
      className="workbench-panel"
      role="status"
      aria-label="Workbench status"
    >
      Workbench is connected through the generic panel surface.
    </div>
  );
}

export const workbenchPluginUi: PluginUiModule = {
  overview: Overview,
  details: Details,
  preferences: Preferences,
  status: Status,
};
