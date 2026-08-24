import { useEffect, useState } from "react";

import type {
  ZenXCapabilitySnapshot,
  ZenXCapabilitySummary,
  ZenXPluginSnapshot,
  ZenXPluginMutationResult,
  ZenXPluginPackageSource,
  ZenXPluginSummary,
} from "../../main/capabilities/types.js";
import {
  marketplaceCatalogView,
  marketplacePackageSource,
  type MarketplaceCatalogSnapshot,
  type MarketplaceCatalogViewEntry,
} from "../../marketplace.js";
import { Icon } from "./icons.js";

type Confirmation = { pluginId: string; action: "uninstall" | "delete-data" };

export function CapabilitySettings() {
  const [capabilities, setCapabilities] =
    useState<ZenXCapabilitySnapshot | null>(null);
  const [plugins, setPlugins] = useState<ZenXPluginSnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceMode, setSourceMode] =
    useState<ZenXPluginPackageSource["mode"]>("npm");
  const [packageSpec, setPackageSpec] = useState("");

  useEffect(() => {
    let active = true;
    const disposeCapabilities = window.zenx.capabilities.onChange(
      (value) => active && setCapabilities(value),
    );
    const disposePlugins = window.zenx.plugins.onChange(
      (value) => active && setPlugins(value),
    );
    void Promise.all([
      window.zenx.capabilities.get(),
      window.zenx.plugins.get(),
    ]).then(
      ([nextCapabilities, nextPlugins]) => {
        if (!active) return;
        setCapabilities(nextCapabilities);
        setPlugins(nextPlugins);
      },
      (reason: unknown) => active && setError(describeError(reason)),
    );
    return () => {
      active = false;
      disposeCapabilities();
      disposePlugins();
    };
  }, []);

  const run = async (
    key: string,
    operation: () => Promise<
      ZenXPluginSnapshot | ZenXPluginMutationResult | void
    >,
    success: string,
  ) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const result = await operation();
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

  const installSource = async () => {
    if (packageSpec.trim().length === 0) {
      setError("Enter a package spec or source path.");
      return;
    }
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

  const selectPackage = async (expectedPluginId?: string) => {
    const key =
      expectedPluginId === undefined ? "install" : `update:${expectedPluginId}`;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const result = await window.zenx.plugins.selectPackage(expectedPluginId);
      if (!result.canceled) {
        setPlugins(result.snapshot);
        setNotice(
          expectedPluginId === undefined
            ? "Local plugin installed and enabled."
            : `${expectedPluginId} updated successfully.`,
        );
      }
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(null);
    }
  };

  const selectTarball = async () => {
    setBusy("install-tarball");
    setError(null);
    setNotice(null);
    try {
      const result = await window.zenx.plugins.selectTarball();
      if (!result.canceled) {
        setPlugins(result.snapshot);
        setNotice(
          result.capabilityRefresh.status === "refreshed"
            ? "Plugin tarball installed and enabled."
            : `Plugin tarball installed and enabled, but Agent capability refresh failed: ${result.capabilityRefresh.message}`,
        );
      }
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(null);
    }
  };

  if (capabilities === null || plugins === null) {
    return (
      <div className="page-card settings-card">
        <p>{error ?? "Loading plugins…"}</p>
      </div>
    );
  }
  const legacyCapabilities = capabilities.capabilities.filter(
    (capability) => capability.manifest.schemaVersion === 1,
  );

  return (
    <>
      <div className="page-card settings-card plugin-library-head">
        <span className="plugin-icon">
          <Icon name="layers" />
        </span>
        <div>
          <strong>Installed on this device</strong>
          <span>
            Installing trusts a local package to run on this computer. ZenX
            validates its manifest, compatibility, runtime, tools, and UI before
            changing the active version.
          </span>
        </div>
        <div className="settings-actions">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void selectPackage()}
          >
            {busy === "install" ? "Opening…" : "Install local package"}
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={busy !== null}
            onClick={() => void selectTarball()}
          >
            {busy === "install-tarball" ? "Installing…" : "Install tarball"}
          </button>
        </div>
        <div className="plugin-source-install">
          <label>
            Package source
            <select
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
            Package spec or path
            <input
              value={packageSpec}
              disabled={busy !== null}
              placeholder={sourcePlaceholder(sourceMode)}
              onChange={(event) => setPackageSpec(event.target.value)}
            />
          </label>
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

      <MarketplaceSettings plugins={plugins} busy={busy} run={run} />

      <div className="plugin-lifecycle-list" aria-label="Installed plugins">
        {plugins.plugins.length === 0 ? (
          <div className="page-card settings-card plugin-empty">
            <strong>No plugins installed</strong>
            <span>
              Choose a package tarball or local manifest to add your first
              plugin.
            </span>
          </div>
        ) : (
          plugins.plugins
            .slice()
            .sort((left, right) =>
              left.displayName.localeCompare(right.displayName),
            )
            .map((plugin) => (
              <PluginLifecycleCard
                key={plugin.id}
                plugin={plugin}
                busy={busy}
                confirmation={confirmation}
                setConfirmation={setConfirmation}
                onEnable={(enabled) =>
                  run(
                    `enable:${plugin.id}`,
                    () => window.zenx.plugins.setEnabled(plugin.id, enabled),
                    `${plugin.displayName} ${enabled ? "enabled" : "disabled"}.`,
                  )
                }
                onUpdate={() =>
                  plugin.profileSource === undefined
                    ? selectPackage(plugin.id)
                    : run(
                        `update:${plugin.id}`,
                        () => window.zenx.plugins.update(plugin.id),
                        `${plugin.displayName} updated successfully.`,
                      )
                }
                onUninstall={() =>
                  run(
                    `uninstall:${plugin.id}`,
                    () => window.zenx.plugins.uninstall(plugin.id),
                    `${plugin.displayName} uninstalled. Its data was kept.`,
                  )
                }
                onReinstall={() =>
                  plugin.available
                    ? run(
                        `reinstall:${plugin.id}`,
                        () => window.zenx.plugins.reinstall(plugin.id),
                        `${plugin.displayName} reinstalled.`,
                      )
                    : selectPackage(plugin.id)
                }
                onDeleteData={() =>
                  run(
                    `delete-data:${plugin.id}`,
                    () => window.zenx.plugins.deleteData(plugin.id),
                    `${plugin.displayName} data deleted.`,
                  )
                }
              />
            ))
        )}
      </div>

      {legacyCapabilities.length === 0 ? null : (
        <LegacyCapabilitySettings
          capabilities={legacyCapabilities}
          busy={busy}
          setBusy={setBusy}
          setCapabilities={setCapabilities}
          setError={setError}
        />
      )}
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
  run,
}: {
  plugins: ZenXPluginSnapshot;
  busy: string | null;
  run(
    key: string,
    operation: () => Promise<ZenXPluginMutationResult>,
    success: string,
  ): Promise<void>;
}) {
  const [catalog, setCatalog] = useState<MarketplaceCatalogSnapshot | null>(
    null,
  );
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [detailPackageSpec, setDetailPackageSpec] = useState<string | null>(
    null,
  );
  const [selectedVersions, setSelectedVersions] = useState<
    Readonly<Record<string, string>>
  >({});
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setCatalog(null);
    setCatalogError(null);
    void window.zenx.marketplace.get().then(
      (next) => active && setCatalog(next),
      (reason: unknown) => active && setCatalogError(describeError(reason)),
    );
    return () => {
      active = false;
    };
  }, [loadAttempt]);

  const entries =
    catalog === null ? [] : marketplaceCatalogView(catalog, plugins, query);
  return (
    <section className="marketplace-section" aria-label="Marketplace">
      <div className="page-card settings-card marketplace-head">
        <div>
          <div className="plugin-title-line">
            <h3>Marketplace</h3>
            <span className="plugin-status">Read only</span>
          </div>
          <p>
            Browse package metadata, then install the selected npm version
            through the same trusted plugin lifecycle.
          </p>
        </div>
        <label className="marketplace-search">
          <span>Search</span>
          <input
            aria-label="Search Marketplace"
            placeholder="Name, description, or package"
            value={query}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
      </div>
      {catalogError !== null ? (
        <div className="page-card settings-card marketplace-state" role="alert">
          <strong>Marketplace unavailable</strong>
          <span>{catalogError}</span>
          <button
            type="button"
            className="secondary-button"
            onClick={() => setLoadAttempt((value) => value + 1)}
          >
            Retry
          </button>
        </div>
      ) : catalog === null ? (
        <div className="page-card settings-card marketplace-state">
          <strong>Loading Marketplace…</strong>
          <span>Reading the package catalog.</span>
        </div>
      ) : entries.length === 0 ? (
        <div className="page-card settings-card marketplace-state">
          <strong>No plugins found</strong>
          <span>
            {query.trim().length === 0
              ? "The catalog is currently empty."
              : "Try a different search."}
          </span>
        </div>
      ) : (
        <div className="marketplace-list">
          {entries.map((entry) => {
            const open = detailPackageSpec === entry.packageSpec;
            const selectedVersion =
              selectedVersions[entry.packageSpec] ?? entry.recommendedVersion;
            return (
              <MarketplaceCard
                key={entry.packageSpec}
                entry={entry}
                open={open}
                selectedVersion={selectedVersion}
                busy={busy}
                onToggle={() =>
                  setDetailPackageSpec(open ? null : entry.packageSpec)
                }
                onVersion={(version) =>
                  setSelectedVersions((current) => ({
                    ...current,
                    [entry.packageSpec]: version,
                  }))
                }
                onInstall={async () => {
                  const source = marketplacePackageSource(
                    entry,
                    selectedVersion,
                  );
                  const installed = entry.installed;
                  await run(
                    `marketplace:${entry.packageSpec}`,
                    () =>
                      installed === undefined
                        ? window.zenx.plugins.installSource(source)
                        : window.zenx.plugins.update(
                            installed.pluginId,
                            source,
                          ),
                    installed === undefined
                      ? `${entry.name} v${selectedVersion} installed and enabled.`
                      : `${entry.name} updated to v${selectedVersion}.`,
                  );
                }}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function MarketplaceCard({
  entry,
  open,
  selectedVersion,
  busy,
  onToggle,
  onVersion,
  onInstall,
}: {
  entry: MarketplaceCatalogViewEntry;
  open: boolean;
  selectedVersion: string;
  busy: string | null;
  onToggle(): void;
  onVersion(version: string): void;
  onInstall(): Promise<void>;
}) {
  const selectedInstalled = entry.installed?.version === selectedVersion;
  const actionLabel =
    entry.installed === undefined
      ? `Install v${selectedVersion}`
      : selectedInstalled
        ? "Installed"
        : `Update to v${selectedVersion}`;
  return (
    <article className="page-card marketplace-card">
      <div className="marketplace-summary">
        <span className="plugin-icon marketplace-icon" aria-hidden="true">
          <Icon name={marketplaceIcon(entry.icon)} />
        </span>
        <div className="plugin-lifecycle-copy">
          <div className="plugin-title-line">
            <h3>{entry.name}</h3>
            {entry.curated ? (
              <span className="plugin-status status-enabled">Curated</span>
            ) : null}
            {entry.updateAvailable ? (
              <span className="plugin-status status-enabled">
                Update available
              </span>
            ) : entry.installed === undefined ? null : (
              <span className="plugin-status">Installed</span>
            )}
          </div>
          <p>{entry.description}</p>
          <small>
            Recommended v{entry.recommendedVersion}
            {entry.installed === undefined
              ? ""
              : ` · Installed v${entry.installed.version}`}
          </small>
        </div>
        <button type="button" className="secondary-button" onClick={onToggle}>
          {open ? "Hide details" : "View details"}
        </button>
      </div>
      {open ? (
        <div className="marketplace-detail">
          <div>
            <strong>{entry.packageSpec}</strong>
            <span>{entry.description}</span>
          </div>
          <label>
            Version
            <select
              aria-label={`${entry.name} version`}
              value={selectedVersion}
              disabled={busy !== null}
              onChange={(event) => onVersion(event.target.value)}
            >
              {entry.versions.map((version) => (
                <option key={version.version} value={version.version}>
                  {version.version}
                  {version.version === entry.recommendedVersion
                    ? " · recommended"
                    : ""}
                </option>
              ))}
            </select>
          </label>
          <button
            className="primary-button"
            type="button"
            disabled={busy !== null || selectedInstalled}
            onClick={() => void onInstall()}
          >
            {busy === `marketplace:${entry.packageSpec}`
              ? entry.installed === undefined
                ? "Installing…"
                : "Updating…"
              : actionLabel}
          </button>
        </div>
      ) : null}
    </article>
  );
}

function PluginLifecycleCard({
  plugin,
  busy,
  confirmation,
  setConfirmation,
  onEnable,
  onUpdate,
  onUninstall,
  onReinstall,
  onDeleteData,
}: {
  plugin: ZenXPluginSummary;
  busy: string | null;
  confirmation: Confirmation | null;
  setConfirmation(value: Confirmation | null): void;
  onEnable(enabled: boolean): Promise<void>;
  onUpdate(): Promise<void>;
  onUninstall(): Promise<void>;
  onReinstall(): Promise<void>;
  onDeleteData(): Promise<void>;
}) {
  const confirming =
    confirmation?.pluginId === plugin.id ? confirmation.action : null;
  const active = plugin.lifecycle === "enabled";
  const unavailable = plugin.lifecycle === "uninstalled" && !plugin.available;
  return (
    <article
      className="page-card plugin-lifecycle-card"
      data-lifecycle={plugin.lifecycle}
    >
      <div className="plugin-lifecycle-main">
        <span className="plugin-icon">
          <Icon name={pluginIcon(plugin.id)} />
        </span>
        <div className="plugin-lifecycle-copy">
          <div className="plugin-title-line">
            <h3>{plugin.displayName}</h3>
            <span className={`plugin-status status-${plugin.lifecycle}`}>
              {plugin.lifecycle}
            </span>
          </div>
          <p>{plugin.description ?? "No package description provided."}</p>
          <small>
            {plugin.profileSource !== undefined
              ? profileSourceLabel(plugin.profileSource.mode)
              : plugin.source === "bundled"
                ? "Bundled with ZenX"
                : "Local package"}
            {` · v${plugin.version} · ZenX ${plugin.compatibility ?? "compatibility unknown"}`}
            {` · ${String(plugin.contributionCount)} product contributions`}
          </small>
        </div>
      </div>
      <div
        className="plugin-actions"
        aria-label={`${plugin.displayName} actions`}
      >
        {plugin.lifecycle === "uninstalled" ? (
          <button
            className="primary-button"
            type="button"
            disabled={busy !== null}
            onClick={() => void onReinstall()}
          >
            {busy === `reinstall:${plugin.id}`
              ? "Reinstalling…"
              : unavailable
                ? "Choose package…"
                : "Reinstall"}
          </button>
        ) : (
          <>
            <button
              className="secondary-button"
              type="button"
              disabled={busy !== null}
              onClick={() => void onEnable(!active)}
            >
              {busy === `enable:${plugin.id}`
                ? "Applying…"
                : active
                  ? "Disable"
                  : "Enable"}
            </button>
            {plugin.source === "local" ? (
              <button
                className="secondary-button"
                type="button"
                disabled={busy !== null}
                onClick={() => void onUpdate()}
              >
                {busy === `update:${plugin.id}` ? "Opening…" : "Update…"}
              </button>
            ) : null}
            <button
              className="danger-button"
              type="button"
              disabled={busy !== null}
              onClick={() =>
                setConfirmation({ pluginId: plugin.id, action: "uninstall" })
              }
            >
              Uninstall
            </button>
          </>
        )}
        <button
          className="danger-button quiet-danger"
          type="button"
          disabled={busy !== null || active}
          title={
            active
              ? "Disable or uninstall this plugin before deleting its data"
              : undefined
          }
          onClick={() =>
            setConfirmation({ pluginId: plugin.id, action: "delete-data" })
          }
        >
          Delete data
        </button>
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
                void (confirming === "uninstall"
                  ? onUninstall()
                  : onDeleteData())
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
      return "Bundled with ZenX";
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

function LegacyCapabilitySettings({
  capabilities,
  busy,
  setBusy,
  setCapabilities,
  setError,
}: {
  capabilities: ZenXCapabilitySummary[];
  busy: string | null;
  setBusy(value: string | null): void;
  setCapabilities(value: ZenXCapabilitySnapshot): void;
  setError(value: string | null): void;
}) {
  const setGranted = async (
    capability: ZenXCapabilitySummary,
    grant: boolean,
  ) => {
    setBusy(`grant:${capability.manifest.id}`);
    setError(null);
    try {
      setCapabilities(
        grant
          ? await window.zenx.capabilities.grant(capability.manifest.id)
          : await window.zenx.capabilities.revoke(capability.manifest.id),
      );
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="page-card settings-card legacy-capabilities">
      <div className="settings-card-head">
        <div>
          <h3>Legacy capabilities</h3>
          <p>
            Older built-in integrations still use grants until they move to the
            plugin lifecycle.
          </p>
        </div>
      </div>
      <div className="capability-list">
        {capabilities.map((capability) => {
          const granted =
            capability.manifest.permissions.length > 0 &&
            capability.manifest.permissions.length ===
              capability.granted.length;
          return (
            <div className="capability-row" key={capability.manifest.id}>
              <span className="plugin-icon">
                <Icon name={pluginIcon(capability.manifest.id)} />
              </span>
              <div>
                <strong>
                  {capability.manifest.schemaVersion === 1
                    ? capability.manifest.displayName
                    : capability.manifest.name}
                </strong>
                <span>
                  {capability.manifest.tools.length} tools ·{" "}
                  {capability.available
                    ? "available"
                    : capability.unavailableReason}
                </span>
              </div>
              <button
                className={granted ? "danger-button" : "secondary-button"}
                type="button"
                disabled={
                  busy !== null ||
                  !capability.available ||
                  capability.manifest.permissions.length === 0
                }
                onClick={() => void setGranted(capability, !granted)}
              >
                {granted ? "Revoke" : "Grant"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function pluginSpacesForSettings(
  snapshot: ZenXPluginSnapshot,
): ZenXPluginSummary[] {
  return snapshot.plugins.filter(
    (plugin) =>
      plugin.lifecycle !== "uninstalled" && plugin.contributionCount > 0,
  );
}

function pluginIcon(
  id: string,
): "search" | "panel-right" | "trigger" | "users" | "layers" {
  if (id === "browser") return "search";
  if (id === "computer") return "panel-right";
  if (id.includes("triggers")) return "trigger";
  if (id.includes("rooms")) return "users";
  return "layers";
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
