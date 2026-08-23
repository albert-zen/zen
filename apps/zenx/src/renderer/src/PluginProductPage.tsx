import { useEffect, useState } from "react";

import type { ZenXPluginSnapshot } from "../../main/capabilities/types.js";
import { Icon } from "./icons.js";
import {
  GenericPluginUiHost,
  createPluginUiRegistry,
  type PluginUiRegistry,
} from "./plugin-ui-host.js";
import { registerBundledAutomationUi } from "./bundled-automation-ui.js";

export const pluginUiRegistry = createPluginUiRegistry();
registerBundledAutomationUi(pluginUiRegistry);

export function PluginProductPage({
  snapshot,
  route,
  navigate,
  onOpenSidebar,
  registry = pluginUiRegistry,
}: {
  snapshot: ZenXPluginSnapshot;
  route: string;
  navigate(route: string): void;
  onOpenSidebar(): void;
  registry?: PluginUiRegistry;
}) {
  const target =
    snapshot.pages.find((page) => page.route === route) ??
    snapshot.subroutes.find((subroute) => subroute.route === route);
  const theme = useAppearance();
  if (target?.surfaceId === undefined) return null;
  const panels = (snapshot.panels ?? []).filter(
    (panel) => panel.pluginId === target.pluginId,
  );
  const menus = (snapshot.menus ?? [])
    .filter(
      (menu) => menu.pluginId === target.pluginId && menu.location === "page",
    )
    .sort(
      (left, right) =>
        (left.order ?? 0) - (right.order ?? 0) ||
        left.key.localeCompare(right.key),
    );
  return (
    <section
      className="product-page plugin-product-page"
      aria-label={target.title}
    >
      <header className="page-header">
        <div className="page-title">
          <button
            className="icon-button mobile-menu"
            type="button"
            aria-label="Open sidebar"
            onClick={onOpenSidebar}
          >
            <Icon name="tree" />
          </button>
          <div>
            <h1>{target.title}</h1>
            <p>Provided by {target.pluginId}</p>
          </div>
        </div>
        <div
          className="plugin-menu"
          role="toolbar"
          aria-label={`${target.title} commands`}
        >
          {menus.map((menu) => (
            <button
              key={menu.key}
              type="button"
              onClick={() =>
                void window.zenx.plugins.executeCommand(
                  menu.pluginId,
                  menu.commandId,
                )
              }
            >
              {menu.label}
            </button>
          ))}
        </div>
      </header>
      <div className="page-scroll plugin-page-scroll">
        <GenericPluginUiHost
          registry={registry}
          snapshot={snapshot}
          pluginId={target.pluginId}
          surfaceId={target.surfaceId}
          context={{ route, handleId: `${target.pluginId}:context` }}
          theme={theme}
          navigate={navigate}
          executeCommand={window.zenx.plugins.executeCommand}
          readHandle={window.zenx.plugins.readHandle}
          className="plugin-primary-surface"
        />
        {panels.map((panel) => (
          <aside key={panel.key} aria-label={panel.title}>
            <PluginMenu
              snapshot={snapshot}
              pluginId={panel.pluginId}
              location="panel"
              label={`${panel.title} commands`}
            />
            <GenericPluginUiHost
              registry={registry}
              snapshot={snapshot}
              pluginId={panel.pluginId}
              surfaceId={panel.surfaceId}
              context={{ route, handleId: `${panel.pluginId}:context` }}
              theme={theme}
              navigate={navigate}
              executeCommand={window.zenx.plugins.executeCommand}
              readHandle={window.zenx.plugins.readHandle}
            />
          </aside>
        ))}
      </div>
    </section>
  );
}

export function PluginSettingsSurfaces({
  snapshot,
  registry = pluginUiRegistry,
}: {
  snapshot: ZenXPluginSnapshot;
  registry?: PluginUiRegistry;
}) {
  const theme = useAppearance();
  return (snapshot.settings ?? []).map((settings) => (
    <section key={settings.key} aria-label={settings.title}>
      <PluginMenu
        snapshot={snapshot}
        pluginId={settings.pluginId}
        location="settings"
        label={`${settings.title} commands`}
      />
      <GenericPluginUiHost
        registry={registry}
        snapshot={snapshot}
        pluginId={settings.pluginId}
        surfaceId={settings.surfaceId}
        context={{
          route: "settings",
          handleId: `${settings.pluginId}:context`,
        }}
        theme={theme}
        executeCommand={window.zenx.plugins.executeCommand}
        readHandle={window.zenx.plugins.readHandle}
      />
    </section>
  ));
}

export function PluginAgentPanels({
  snapshot,
  threadId,
  registry = pluginUiRegistry,
}: {
  snapshot: ZenXPluginSnapshot;
  threadId: string;
  registry?: PluginUiRegistry;
}) {
  const theme = useAppearance();
  return (snapshot.panels ?? []).map((panel) => (
    <GenericPluginUiHost
      key={panel.key}
      registry={registry}
      snapshot={snapshot}
      pluginId={panel.pluginId}
      surfaceId={panel.surfaceId}
      context={{ route: "agent", threadId }}
      theme={theme}
      executeCommand={window.zenx.plugins.executeCommand}
      readHandle={window.zenx.plugins.readHandle}
    />
  ));
}

function PluginMenu({
  snapshot,
  pluginId,
  location,
  label,
}: {
  snapshot: ZenXPluginSnapshot;
  pluginId: string;
  location: "panel" | "settings";
  label: string;
}) {
  const menus = (snapshot.menus ?? [])
    .filter((menu) => menu.pluginId === pluginId && menu.location === location)
    .sort(
      (left, right) =>
        (left.order ?? 0) - (right.order ?? 0) ||
        left.key.localeCompare(right.key),
    );
  if (menus.length === 0) return null;
  return (
    <div className="plugin-menu" role="toolbar" aria-label={label}>
      {menus.map((menu) => (
        <button
          key={menu.key}
          type="button"
          onClick={() =>
            void window.zenx.plugins.executeCommand(
              menu.pluginId,
              menu.commandId,
            )
          }
        >
          {menu.label}
        </button>
      ))}
    </div>
  );
}

function useAppearance(): "light" | "dark" {
  const read = () =>
    document.documentElement.dataset.appearance === "dark" ? "dark" : "light";
  const [theme, setTheme] = useState<"light" | "dark">(read);
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-appearance"],
    });
    return () => observer.disconnect();
  }, []);
  return theme;
}
