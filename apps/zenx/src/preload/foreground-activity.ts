import { ipcRenderer } from "electron";

// Dedicated sandbox preload: no general ZenX, protocol, approval or settings API.
const renderChannel = "zenx:foreground-activity:render";
const paintedChannel = "zenx:foreground-activity:painted";
const stopChannel = "zenx:foreground-activity:stop";
let version = 0;
ipcRenderer.on(
  renderChannel,
  (
    _event,
    state: {
      version: number;
      agentLabel: string;
      activityLabel: string;
      stopLabel: string;
      stopDescription: string;
      title: string;
      stopping: boolean;
    },
  ) => {
    version = state.version;
    const names = document.getElementById("agent-names");
    const activity = document.getElementById("activity-label");
    const stop = document.getElementById("stop") as HTMLButtonElement | null;
    const status = document.getElementById("status");
    if (names) names.textContent = state.agentLabel;
    if (activity) activity.textContent = state.activityLabel;
    if (stop) {
      stop.textContent = state.stopLabel;
      stop.disabled = state.stopping;
      stop.setAttribute("aria-label", state.stopDescription);
    }
    if (status) {
      status.dataset.stopping = String(state.stopping);
      status.title = state.title;
    }
    const edges = document.getElementById("edges");
    if (edges) edges.dataset.stopping = String(state.stopping);
    document.documentElement.dataset.stopping = String(state.stopping);
    // Two compositor opportunities after showInactive; the Host fails closed if
    // this exact owned main frame does not acknowledge the requested rendering.
    const paintedVersion = version;
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        ipcRenderer.send(paintedChannel, paintedVersion),
      ),
    );
  },
);
window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("stop")?.addEventListener("click", (event) => {
    if (event.isTrusted) ipcRenderer.send(stopChannel, version);
  });
});
