import React, { useEffect, useMemo, useState } from "react";

import type {
  ZenXPluginMutationResult,
  ZenXPluginPackageSource,
  ZenXPluginSnapshot,
  ZenXPluginSummary,
} from "../../main/capabilities/types.js";
import {
  marketplaceInventoryView,
  marketplacePackageSource,
  type MarketplaceCatalogLoadSnapshot,
  type MarketplaceInventoryViewEntry,
} from "../../marketplace.js";
import { Icon } from "./icons.js";

type Confirmation = { pluginId: string; action: "uninstall" | "delete-data" };
type InventoryFilter = "all" | "installed" | "built-in";
type PluginOperationResult =
  ZenXPluginSnapshot | ZenXPluginMutationResult | void | null;

export function PluginSettings() {
  const [plugins, setPlugins] = useState<ZenXPluginSnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const disposePlugins = window.zenx.plugins.onChange(
      (value) => active && setPlugins(value),
    );
    void window.zenx.plugins.get().then(
      (nextPlugins) => active && setPlugins(nextPlugins),
      (reason: unknown) => active && setError(describeError(reason)),
    );
    return () => {
      active = false;
      disposePlugins();
    };
  }, []);

  const run = async (
    key: string,
    operation: () => Promise<PluginOperationResult>,
    success: string,
  ) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const result = await operation();
      if (result === null) return;
      const next =
        result !== undefined && "snapshot" in result ? result.snapshot : result;
      if (next !== undefined) setPlugins(next);
      setConfirmation(null);
      setNotice(
        result !== undefined &&
          "capabilityRefresh" in result &&
          result.capabilityRefresh.status === "failed"
          ? `${success} Agent capability refresh failed: ${result.capabilityRefresh.message}`
          : success,
      );
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(null);
    }
  };

  if (plugins === null) {
    return (
      <div className="page-card settings-card marketplace-state">
        <strong>Loading plugins…</strong>
        {error === null ? null : <span>{error}</span>}
      </div>
    );
  }

  return (
    <>
      <MarketplaceSettings
        plugins={plugins}
        busy={busy}
        confirmation={confirmation}
        setConfirmation={setConfirmation}
        run={run}
      />
      {notice ? (
        <div className="settings-success" role="status">
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className="settings-error" role="alert">
          <Icon name="warning" />
          {error}
        </div>
      ) : null}
    </>
  );
}

function MarketplaceSettings({
  plugins,
  busy,
  confirmation,
  setConfirmation,
  run,
}: {
  plugins: ZenXPluginSnapshot;
  busy: string | null;
  confirmation: Confirmation | null;
  setConfirmation(value: Confirmation | null): void;
  run(
    key: string,
    operation: () => Promise<PluginOperationResult>,
    success: string,
  ): Promise<void>;
}) {
  const [catalog, setCatalog] = useState<MarketplaceCatalogLoadSnapshot | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<InventoryFilter>("all");
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceMode, setSourceMode] =
    useState<ZenXPluginPackageSource["mode"]>("npm");
  const [packageSpec, setPackageSpec] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setCatalog(null);
    void window.zenx.marketplace.get().then(
      (next) => active && setCatalog(next),
      (reason: unknown) =>
        active &&
        setCatalog({
          entries: [],
          builtIns: [],
          error: describeError(reason),
        }),
    );
    return () => {
      active = false;
    };
  }, [loadAttempt]);

  const inventory = useMemo(
    () =>
      marketplaceInventoryView(
        catalog ?? { entries: [], builtIns: [] },
        plugins,
      ),
    [catalog, plugins],
  );
  const entries = inventory.filter((entry) => {
    if (filter === "built-in" && entry.source !== "built-in") return false;
    if (
      filter === "installed" &&
      entry.lifecycle !== "enabled" &&
      entry.lifecycle !== "installed"
    ) {
      return false;
    }
    const needle = query.trim().toLocaleLowerCase();
    return (
      needle.length === 0 ||
      [entry.name, entry.description, entry.packageSpec ?? ""].some((value) =>
        value.toLocaleLowerCase().includes(needle),
      )
    );
  });

  const installSource = async () => {
    if (packageSpec.trim().length === 0) return;
    await run(
      "install-source",
      () =>
        window.zenx.plugins.installSource({
          mode: sourceMode,
          packageSpec: packageSpec.trim(),
        }),
      "Plugin installed and enabled.",
    );
  };
  const selectTarball = async () => {
    await run(
      "install-tarball",
      async () => {
        const result = await window.zenx.plugins.selectTarball();
        return result.canceled ? null : result;
      },
      "Plugin tarball installed and enabled.",
    );
  };

  return (
    <section className="marketplace-section" aria-label="Marketplace">
      <header className="marketplace-intro">
        <div>
          <span className="marketplace-eyebrow">Plugin inventory</span>
          <p>Find a plugin and control its lifecycle in one place.</p>
        </div>
        <span className="marketplace-count">
          {String(inventory.length).padStart(2, "0")} on this device
        </span>
      </header>

      <div className="marketplace-rail">
        <label className="marketplace-search">
          <Icon name="search" />
          <span className="sr-only">Search plugins</span>
          <input
            aria-label="Search plugins"
            placeholder="Search name, purpose, or package"
            value={query}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          {query.length === 0 ? null : (
            <button type="button" onClick={() => setQuery("")}>
              Clear
            </button>
          )}
        </label>
        <div className="marketplace-filters" aria-label="Plugin filters">
          {(
            [
              ["all", "All"],
              ["installed", "Installed"],
              ["built-in", "Built in"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="marketplace-source-toggle"
          aria-expanded={sourceOpen}
          aria-controls="plugin-source-panel"
          onClick={() => setSourceOpen((open) => !open)}
        >
          Install from source…
        </button>
      </div>

      {sourceOpen ? (
        <div
          id="plugin-source-panel"
          className="page-card plugin-source-install"
        >
          <div className="plugin-source-copy">
            <strong>Install from source</strong>
            <span>
              Advanced: package code is trusted to run on this computer after
              validation.
            </span>
          </div>
          <label>
            Source
            <select
              aria-label="Plugin source"
              value={sourceMode}
              disabled={busy !== null}
              onChange={(event) =>
                setSourceMode(
                  event.target.value as ZenXPluginPackageSource["mode"],
                )
              }
            >
              <option value="npm">npm registry</option>
              <option value="git">Git (commit pinned)</option>
              <option value="local-copy">Local directory copy</option>
              <option value="dev-link">Development link</option>
            </select>
          </label>
          <label>
            Package or path
            <input
              value={packageSpec}
              disabled={busy !== null}
              placeholder={sourcePlaceholder(sourceMode)}
              onChange={(event) => setPackageSpec(event.target.value)}
            />
          </label>
          <div className="plugin-source-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={busy !== null}
              onClick={() => void selectTarball()}
            >
              {busy === "install-tarball" ? "Installing…" : "Choose tarball…"}
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={busy !== null || packageSpec.trim().length === 0}
              onClick={() => void installSource()}
            >
              {busy === "install-source" ? "Installing…" : "Install source"}
            </button>
          </div>
        </div>
      ) : null}

      {catalog?.error === undefined ? null : (
        <div className="marketplace-catalog-warning" role="alert">
          <Icon name="warning" />
          <div>
            <strong>External catalog unavailable</strong>
            <span>{catalog.error} Local plugins remain manageable.</span>
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={() => setLoadAttempt((value) => value + 1)}
          >
            Retry
          </button>
        </div>
      )}

      {catalog === null && inventory.length === 0 ? (
        <div className="page-card settings-card marketplace-state">
          <strong>Loading plugin inventory…</strong>
          <span>Reading built-in and external package metadata.</span>
        </div>
      ) : entries.length === 0 ? (
        <div className="page-card settings-card marketplace-state">
          <strong>No plugins found</strong>
          <span>
            {query.trim().length === 0
              ? "No plugins match this filter."
              : "Try a different search."}
          </span>
        </div>
      ) : (
        <div className="marketplace-list" aria-label="Plugin inventory">
          {entries.map((entry) => (
            <MarketplaceInventoryCard
              key={entry.key}
              entry={entry}
              busy={busy}
              confirmation={confirmation}
              setConfirmation={setConfirmation}
              run={run}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function MarketplaceInventoryCard({
  entry,
  busy,
  confirmation,
  setConfirmation,
  run,
}: {
  entry: MarketplaceInventoryViewEntry;
  busy: string | null;
  confirmation: Confirmation | null;
  setConfirmation(value: Confirmation | null): void;
  run(
    key: string,
    operation: () => Promise<PluginOperationResult>,
    success: string,
  ): Promise<void>;
}) {
  const [selectedVersion, setSelectedVersion] = useState(
    entry.recommendedVersion ?? "",
  );
  const plugin = entry.plugin;
  const pluginId = entry.pluginId;
  const confirming =
    pluginId !== undefined && confirmation?.pluginId === pluginId
      ? confirmation.action
      : null;
  const active = plugin?.lifecycle === "enabled";
  const source =
    entry.source === "built-in"
      ? "Built in"
      : entry.source === "catalog"
        ? "Marketplace"
        : plugin?.profileSource === undefined
          ? "Installed source"
          : profileSourceLabel(plugin.profileSource.mode);

  const installCatalogVersion = async () => {
    if (entry.source !== "catalog" || selectedVersion.length === 0) return;
    const sourceEntry = {
      packageSpec: entry.packageSpec!,
      name: entry.name,
      description: entry.description,
      icon: entry.icon,
      recommendedVersion: entry.recommendedVersion!,
      curated: entry.curated,
      versions: entry.versions,
    };
    const selectedSource = marketplacePackageSource(
      sourceEntry,
      selectedVersion,
    );
    await run(
      `marketplace:${entry.packageSpec}`,
      () =>
        pluginId === undefined
          ? window.zenx.plugins.installSource(selectedSource)
          : window.zenx.plugins.update(pluginId, selectedSource),
      pluginId === undefined
        ? `${entry.name} v${selectedVersion} installed and enabled.`
        : `${entry.name} updated to v${selectedVersion}.`,
    );
  };

  return (
    <article
      className="page-card marketplace-card"
      data-lifecycle={entry.lifecycle}
      data-available={entry.available}
      data-source={entry.source}
    >
      <span className="plugin-icon marketplace-icon" aria-hidden="true">
        <Icon name={marketplaceIcon(entry.icon)} />
      </span>
      <div className="plugin-lifecycle-copy">
        <div className="plugin-title-line">
          <h3>{entry.name}</h3>
          <span className="plugin-source-badge">{source}</span>
          <span className={`plugin-status status-${entry.lifecycle}`}>
            {lifecycleLabel(entry.lifecycle)}
          </span>
          {!entry.available && entry.lifecycle !== "unavailable" ? (
            <span className="plugin-status status-unavailable">
              Unavailable
            </span>
          ) : null}
          {entry.updateAvailable ? (
            <span className="plugin-status status-update">
              Update available
            </span>
          ) : null}
        </div>
        <p>{entry.description}</p>
        <small>
          {entry.packageSpec ?? pluginId}
          {plugin === undefined ? "" : ` · v${plugin.version}`}
          {plugin === undefined
            ? ""
            : ` · ${String(plugin.contributionCount)} product contributions`}
        </small>
        {entry.unavailableReason === undefined ? null : (
          <div className="plugin-unavailable" role="note">
            <Icon name="warning" />
            <span>{entry.unavailableReason}</span>
          </div>
        )}
      </div>
      <div className="plugin-actions" aria-label={`${entry.name} actions`}>
        {entry.source === "catalog" && entry.versions.length > 0 ? (
          <label className="marketplace-version">
            <span className="sr-only">{entry.name} version</span>
            <select
              aria-label={`${entry.name} version`}
              value={selectedVersion}
              disabled={busy !== null}
              onChange={(event) => setSelectedVersion(event.target.value)}
            >
              {entry.versions.map((version) => (
                <option key={version.version} value={version.version}>
                  v{version.version}
                  {version.version === entry.recommendedVersion
                    ? " · recommended"
                    : ""}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {entry.lifecycle === "unavailable" ? null : entry.lifecycle ===
          "available" ? (
          <button
            className="primary-button"
            type="button"
            disabled={busy !== null}
            onClick={() =>
              void (entry.source === "built-in" && pluginId !== undefined
                ? run(
                    `install-built-in:${pluginId}`,
                    () => window.zenx.plugins.installBuiltIn(pluginId),
                    `${entry.name} installed and enabled.`,
                  )
                : installCatalogVersion())
            }
          >
            {busy === `marketplace:${entry.packageSpec}` ||
            busy === `install-built-in:${pluginId}`
              ? "Installing…"
              : selectedVersion.length === 0
                ? "Install"
                : `Install v${selectedVersion}`}
          </button>
        ) : entry.lifecycle === "uninstalled" && pluginId !== undefined ? (
          <button
            className="primary-button"
            type="button"
            disabled={busy !== null || !entry.available}
            onClick={() =>
              void run(
                `reinstall:${pluginId}`,
                () => window.zenx.plugins.reinstall(pluginId),
                `${entry.name} reinstalled.`,
              )
            }
          >
            {busy === `reinstall:${pluginId}` ? "Reinstalling…" : "Reinstall"}
          </button>
        ) : pluginId === undefined ? null : (
          <>
            <button
              className="secondary-button"
              type="button"
              disabled={busy !== null || (!entry.available && !active)}
              title={
                !entry.available && !active
                  ? entry.unavailableReason
                  : undefined
              }
              onClick={() =>
                void run(
                  `enable:${pluginId}`,
                  () => window.zenx.plugins.setEnabled(pluginId, !active),
                  `${entry.name} ${active ? "disabled" : "enabled"}.`,
                )
              }
            >
              {busy === `enable:${pluginId}`
                ? "Applying…"
                : active
                  ? "Disable"
                  : "Enable"}
            </button>
            {entry.source === "catalog" &&
            plugin?.version !== selectedVersion ? (
              <button
                className="primary-button"
                type="button"
                disabled={busy !== null}
                onClick={() => void installCatalogVersion()}
              >
                {busy === `marketplace:${entry.packageSpec}`
                  ? "Updating…"
                  : `Update to v${selectedVersion}`}
              </button>
            ) : entry.source === "source" && plugin?.source === "local" ? (
              <button
                className="secondary-button"
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  void run(
                    `update:${pluginId}`,
                    () => window.zenx.plugins.update(pluginId),
                    `${entry.name} updated successfully.`,
                  )
                }
              >
                {busy === `update:${pluginId}` ? "Opening…" : "Update…"}
              </button>
            ) : null}
            <button
              className="danger-button"
              type="button"
              disabled={busy !== null}
              onClick={() => setConfirmation({ pluginId, action: "uninstall" })}
            >
              Uninstall
            </button>
          </>
        )}

        {pluginId !== undefined && plugin !== undefined ? (
          <button
            className="danger-button quiet-danger"
            type="button"
            disabled={busy !== null || active}
            title={
              active
                ? "Disable or uninstall this plugin before deleting its data"
                : undefined
            }
            onClick={() => setConfirmation({ pluginId, action: "delete-data" })}
          >
            Delete data
          </button>
        ) : null}
      </div>
      {confirming ? (
        <div
          className="plugin-confirm"
          role="group"
          aria-label={`Confirm ${confirming}`}
        >
          <p>
            {confirming === "uninstall"
              ? "Uninstall removes this plugin's pages, commands, runtime, and Agent tools. Its data stays on this device."
              : "Delete this plugin's saved data only. Other plugins and historical Threads are not changed."}
          </p>
          <div>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setConfirmation(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="danger-button"
              autoFocus
              onClick={() =>
                void run(
                  `${confirming}:${pluginId}`,
                  () =>
                    confirming === "uninstall"
                      ? window.zenx.plugins.uninstall(pluginId!)
                      : window.zenx.plugins.deleteData(pluginId!),
                  confirming === "uninstall"
                    ? `${entry.name} uninstalled. Its data was kept.`
                    : `${entry.name} data deleted.`,
                )
              }
            >
              {confirming === "uninstall"
                ? "Confirm uninstall"
                : "Confirm delete data"}
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function profileSourceLabel(mode: ZenXPluginPackageSource["mode"]): string {
  switch (mode) {
    case "bundled":
      return "Built in";
    case "npm":
      return "npm registry";
    case "git":
      return "Commit-pinned Git";
    case "tarball":
      return "Tarball";
    case "local-copy":
      return "Local directory snapshot";
    case "dev-link":
      return "Development link";
  }
}

function sourcePlaceholder(mode: ZenXPluginPackageSource["mode"]): string {
  switch (mode) {
    case "bundled":
      return "App Resource package";
    case "npm":
      return "@scope/plugin@1.2.3";
    case "git":
      return "git+https://…#<commit>";
    case "tarball":
      return "/path/to/plugin.tgz";
    case "local-copy":
    case "dev-link":
      return "/path/to/plugin";
  }
}

export function pluginSpacesForSettings(
  snapshot: ZenXPluginSnapshot,
): ZenXPluginSummary[] {
  return snapshot.plugins.filter(
    (plugin) =>
      plugin.lifecycle !== "uninstalled" && plugin.contributionCount > 0,
  );
}

function marketplaceIcon(
  icon: string,
): "search" | "panel-right" | "trigger" | "users" | "layers" {
  if (
    icon === "search" ||
    icon === "panel-right" ||
    icon === "trigger" ||
    icon === "users"
  ) {
    return icon;
  }
  return "layers";
}

function lifecycleLabel(
  lifecycle: MarketplaceInventoryViewEntry["lifecycle"],
): string {
  switch (lifecycle) {
    case "enabled":
      return "Enabled";
    case "installed":
      return "Disabled";
    case "uninstalled":
      return "Uninstalled";
    case "available":
      return "Available";
    case "unavailable":
      return "Unavailable";
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
