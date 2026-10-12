import { nativeText } from "./native-locale.js";
import { Menu, type MenuItemConstructorOptions } from "electron";

/** Installs ZenX's platform menu policy without adding product navigation. */
export function installApplicationMenu(
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  const template: MenuItemConstructorOptions[] = [
    {
      label: "ZenX",
      submenu: [
        { role: "about", label: nativeText("about") },
        { type: "separator" },
        { role: "hide", label: nativeText("hide") },
        { role: "hideOthers", label: nativeText("hideOthers") },
        { type: "separator" },
        { role: "quit", label: nativeText("quit") },
      ],
    },
    {
      label: nativeText("edit"),
      submenu: [
        { role: "undo", label: nativeText("undo") },
        { role: "redo", label: nativeText("redo") },
        { type: "separator" },
        { role: "cut", label: nativeText("cut") },
        { role: "copy", label: nativeText("copy") },
        { role: "paste", label: nativeText("paste") },
        { role: "selectAll", label: nativeText("selectAll") },
      ],
    },
    {
      label: nativeText("view"),
      submenu: [
        {
          role: "resetZoom",
          label: nativeText("resetZoom"),
          accelerator: "CommandOrControl+0",
        },
        {
          role: "zoomIn",
          label: nativeText("zoomIn"),
          accelerator: "CommandOrControl+Plus",
        },
        {
          role: "zoomOut",
          label: nativeText("zoomOut"),
          accelerator: "CommandOrControl+-",
        },
      ],
    },
    {
      label: nativeText("window"),
      submenu: [
        { role: "minimize", label: nativeText("minimize") },
        { role: "close", label: nativeText("close") },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
