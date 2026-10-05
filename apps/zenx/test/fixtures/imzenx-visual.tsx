import React from "react";
import { createRoot } from "react-dom/client";
import { PluginProductPage } from "../../src/renderer/src/PluginProductPage.js";
import type { ZenXPluginSnapshot } from "../../src/main/capabilities/types.js";
import type { PluginUiSdkV1 } from "../../src/renderer/src/plugin-ui-host.js";
import type {
  ImZenXSetupView,
  ImZenXChannelSave,
} from "../../src/main/imzenx-setup-service.js";
import { IM_CHANNEL_SCHEMAS } from "../../../../packages/zenx-imzenx-plugin/src/channel-schema.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";

// This fixture uses safe projections and mock operations only; it never starts an IM process.
const params = new URLSearchParams(location.search);
let failed = params.has("failed");
const configured = !params.has("new");
document.documentElement.dataset.appearance = params.has("dark")
  ? "dark"
  : "light";
let ownSetup: ImZenXSetupView = {
  configurationFile:
    "/Users/demo/Library/Application Support/ZenX/imzenx/channels.managed.json",
  encryptionAvailable: !params.has("no-encryption"),
  runtime: {
    projectDirectory:
      "/Users/demo/Library/Application Support/ZenX/imzenx/runtime",
    pythonExecutable:
      "/Users/demo/Library/Application Support/ZenX/imzenx/runtime/.venv/bin/python",
    prepared: configured && !params.has("missing-sdk"),
    preparing: false,
    source:
      "Trusted IMZen project · pinned private SDK · locked dependencies · existing repository access",
  },
  channels: IM_CHANNEL_SCHEMAS.map((schema) => ({
    ...schema,
    fields: [...schema.fields],
    values: Object.fromEntries(
      schema.fields
        .filter((field) => !field.secret)
        .map((field) => [
          field.key,
          field.key === "app_id" && configured
            ? "123456"
            : field.key === "allowed_user_ids" && configured
              ? "demo-user"
              : (field.defaultValue ?? ""),
        ]),
    ),
    secretConfigured: Object.fromEntries(
      schema.fields
        .filter((field) => field.secret)
        .map((field) => [field.key, configured && schema.id === "qq"]),
    ),
  })),
};
let configuration: unknown = configured
  ? {
      pythonExecutable: ownSetup.runtime.pythonExecutable,
      channelsConfigFile: ownSetup.configurationFile,
      cwd: "/Users/demo/work",
      sharedFilesystemRoot: "",
      permissionMode: "approval-required",
      allowUnrestrictedFullAccess: false,
    }
  : null;
let state = failed
  ? "failed"
  : configured
    ? params.has("connected")
      ? "connected"
      : "prepared"
    : "unconfigured";
const wait = async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
};
const sdk: PluginUiSdkV1 = {
  version: 1,
  pluginId: "imzenx",
  theme: "light",
  context: {},
  navigation: { navigate: () => {} },
  handles: { read: async () => ({}) },
  commands: {
    execute: async (command, input) => {
      await wait();
      if (command === "prepare") {
        configuration = input;
        state = "prepared";
        failed = false;
      }
      if (command === "readiness") {
        const ready =
          ownSetup.runtime.prepared &&
          ownSetup.channels.some(
            (channel) =>
              channel.values.enabled &&
              Object.values(channel.secretConfigured).some(Boolean),
          );
        return {
          ready,
          checks: [
            {
              id: "sdk",
              status: ownSetup.runtime.prepared ? "ready" : "blocked",
              message: ownSetup.runtime.prepared
                ? "Pinned private SDK is available in the selected environment."
                : "The private IM Agent SDK is missing.",
              ...(!ownSetup.runtime.prepared
                ? {
                    action:
                      "Prepare the trusted IMZen environment using the explicit setup action above. Existing private repository access is required.",
                  }
                : {}),
            },
            {
              id: "credentials",
              status: ready ? "ready" : "blocked",
              message: ready
                ? "The selected channel has locally saved credentials. No credential values are returned."
                : "Save the channel credentials securely before connecting.",
            },
          ],
          enabledChannels: ready ? ["qq"] : [],
          singleConsumerConfirmationRequired: true,
          connectionState: state,
        };
      }
      if (command === "connect") {
        if (
          !(input as { singleConsumerConfirmed?: boolean })
            ?.singleConsumerConfirmed
        )
          throw new Error("Confirm the single bot consumer before connecting.");
        state = "connected";
        failed = false;
      }
      return {
        state,
        configuration,
        activeConfiguration: state === "connected" ? configuration : null,
        explicitConnectRequired: true,
        singleConsumerConfirmationRequired: true,
        ...(failed
          ? {
              error:
                "IM Gateway failed to start. Check Python and channel preparation.",
            }
          : {}),
      };
    },
  },
};
// Render the actual Host composition: a leaf-only preview missed its 60px row.
const snapshot: ZenXPluginSnapshot = {
  plugins: [],
  sidebar: [],
  subroutes: [],
  settings: [],
  panels: [],
  commands: [],
  menus: [],
  pages: [
    {
      id: "connection",
      key: "imzenx:connection",
      pluginId: "imzenx",
      title: "IMZenX",
      route: "/plugins/imzenx/connection",
      surfaceId: "connection",
    },
  ],
  bundles: [
    {
      id: "main",
      key: "imzenx:main",
      pluginId: "imzenx",
      apiVersion: 1,
      kind: "trusted",
      entry: "zenx/bundled/imzenx-ui",
    },
  ],
  surfaces: [
    {
      id: "connection",
      key: "imzenx:connection",
      pluginId: "imzenx",
      bundleId: "main",
      exportName: "connection",
    },
  ],
};
Object.defineProperty(window, "zenx", {
  value: {
    imzenx: {
      inspect: async () => {
        await wait();
        return ownSetup;
      },
      prepareRuntime: async () => {
        await wait();
        ownSetup = {
          ...ownSetup,
          runtime: { ...ownSetup.runtime, prepared: true },
        };
        return ownSetup;
      },
      saveChannel: async (input: ImZenXChannelSave) => {
        await wait();
        ownSetup = {
          ...ownSetup,
          channels: ownSetup.channels.map((channel) =>
            channel.id !== input.channelId
              ? channel
              : {
                  ...channel,
                  values: { ...channel.values, ...input.values },
                  secretConfigured: Object.fromEntries(
                    channel.fields
                      .filter((field) => field.secret)
                      .map((field) => [
                        field.key,
                        input.secrets[field.key]?.operation === "replace"
                          ? true
                          : input.secrets[field.key]?.operation === "clear"
                            ? false
                            : channel.secretConfigured[field.key],
                      ]),
                  ),
                },
          ),
        };
        return ownSetup;
      },
    },
    settings: {
      getDirectoryBrowser: async () => ({
        initialPath: "/Users/demo/work",
        locations: [{ label: "Work", path: "/Users/demo/work" }],
      }),
      listDirectory: async (directory: string) => ({
        path: directory,
        parent: "/Users/demo",
        breadcrumbs: [
          { label: "demo", path: "/Users/demo" },
          { label: "work", path: directory },
        ],
        directories: [],
      }),
    },
    plugins: {
      executeCommand: (_pluginId: string, command: string, input?: unknown) =>
        sdk.commands.execute(command, input),
      readHandle: async () => ({}),
    },
  },
});
createRoot(document.getElementById("root")!).render(
  <main style={{ height: "100vh", overflow: "hidden" }}>
    <PluginProductPage
      snapshot={snapshot}
      route="/plugins/imzenx/connection"
      navigate={() => {}}
    />
  </main>,
);
