import { fileURLToPath } from "node:url";
import { realpath } from "node:fs/promises";
import { patchAppShotDbus } from "./patch-app-shot-dbus.mjs";

// Exact pinned dependency patch only; no bus connection or OS configuration.
const stagingRoot = await realpath(
  fileURLToPath(new URL("../../../", import.meta.url)),
);
await patchAppShotDbus({ stagingRoot });
