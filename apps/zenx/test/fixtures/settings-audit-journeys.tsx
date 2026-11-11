/** Production Settings and DirectoryPicker; directory launcher and data are QA-only. */
import "../../scripts/settings-audit-preview.js";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { DirectoryPicker } from "../../src/renderer/src/DirectoryPicker.js";
import { i18n } from "../../src/renderer/src/i18n.js";

const query = new URLSearchParams(location.search);
let failSnapshot = query.get("directoryFailure") === "1";
const calls: string[] = [];
Object.assign(window.zenx.settings, {
  getDirectoryBrowser: async () => {
    calls.push("snapshot");
    if (failSnapshot) {
      failSnapshot = false;
      throw new Error(
        "Synthetic directory read failure. No filesystem access.",
      );
    }
    return {
      initialPath: "/synthetic",
      locations: [{ label: "Synthetic", path: "/synthetic" }],
    };
  },
  listDirectory: async (directory: string) => {
    calls.push(`list:${directory}`);
    if (!["/synthetic", "/synthetic/empty"].includes(directory))
      throw new Error("Directory outside synthetic fixture");
    return {
      path: directory,
      parent: directory === "/synthetic" ? null : "/synthetic",
      breadcrumbs: [
        { label: "Synthetic", path: "/synthetic" },
        ...(directory.endsWith("/empty")
          ? [{ label: "Empty", path: directory }]
          : []),
      ],
      directories:
        directory === "/synthetic"
          ? [{ name: "Empty", path: "/synthetic/empty" }]
          : [],
    };
  },
});
Object.assign(window, { __directoryAudit: { calls } });

function DirectoryJourney() {
  const [open, setOpen] = useState(false);
  return (
    <main className="page-scroll">
      <p>QA-only launcher · Production DirectoryPicker · Synthetic paths</p>
      <button
        id="directory-audit-open"
        className="primary-button"
        onClick={() => setOpen(true)}
      >
        {i18n.t("shell:chooseProjectFolder")}
      </button>
      {open && (
        <DirectoryPicker
          onCancel={() => setOpen(false)}
          onSelect={() => {
            throw new Error("Selection is not part of this read-only audit");
          }}
        />
      )}
    </main>
  );
}
if (query.get("scene") === "directory") {
  document.getElementById("root")!.hidden = true;
  const root = document.createElement("div");
  document.body.append(root);
  void i18n
    .changeLanguage(query.get("lang") === "zh-CN" ? "zh-CN" : "en")
    .then(() => createRoot(root).render(<DirectoryJourney />));
}
