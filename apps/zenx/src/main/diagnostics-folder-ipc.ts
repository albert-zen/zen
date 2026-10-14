import { mkdir } from "node:fs/promises";
import { ipcMain, shell } from "electron";
import { ipcChannels } from "../preload/ipc.js";

/** Both locations belong to this Host; the renderer may choose a source, never a path. */
export function registerDiagnosticsFolderIpc(locations: {
  settingsDirectory: string;
  modelDirectory: string;
}): void {
  ipcMain.handle(
    ipcChannels.settingsDiagnosticsOpenFolder,
    async (_event, source: unknown) => {
      if (source !== undefined && source !== "model")
        throw new Error("Invalid diagnostics source");
      const directory =
        source === "model"
          ? locations.modelDirectory
          : locations.settingsDirectory;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const failure = await shell.openPath(directory);
      if (failure.length > 0)
        throw new Error("Could not open diagnostics folder");
    },
  );
}
