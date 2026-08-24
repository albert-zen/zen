import assert from "node:assert/strict";
import test from "node:test";

import type {
  PluginUiSdkV1 as PublicPluginUiSdkV1,
  ZenXPluginHostSdkV1 as PublicPluginHostSdkV1,
  ZenXPluginManifestV2 as PublicPluginManifestV2,
} from "@zenx/plugin-sdk";
import type { ZenXPluginHostSdkV1 as HostPluginHostSdkV1 } from "../src/main/plugin-host-sdk.js";
import type { ZenXPluginManifestV2 as HostPluginManifestV2 } from "../src/main/capabilities/types.js";
import type { PluginUiSdkV1 as HostPluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";

// Compile-time checks: the public types are usable at the current Host boundaries.
const publicSdkFromHost = (value: HostPluginHostSdkV1): PublicPluginHostSdkV1 =>
  value;
const publicManifestFromHost = (
  value: HostPluginManifestV2,
): PublicPluginManifestV2 => value;
const hostManifestFromPublic = (
  value: PublicPluginManifestV2,
): HostPluginManifestV2 => value;
const publicUiSdkFromHost = (value: HostPluginUiSdkV1): PublicPluginUiSdkV1 =>
  value;

test("public plugin SDK types compile at the current Host runtime and UI boundaries", () => {
  assert.ok(true);
  void publicSdkFromHost;
  void publicManifestFromHost;
  void hostManifestFromPublic;
  void publicUiSdkFromHost;
});
