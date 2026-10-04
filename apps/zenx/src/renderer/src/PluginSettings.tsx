import { i18n } from "./i18n.js";
import { useTranslation } from "react-i18next";
import { Select, ActionMenu } from "./ui/controls.js";
import React, { useEffect, useMemo, useRef, useState } from "react";

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
import { PluginAccessReview } from "./PluginAccessReview.js";

type Confirmation = { pluginId: string; action: "uninstall" | "delete-data" };
type InventoryFilter = "all" | "installed" | "built-in";
type PluginOperationResult =
  ZenXPluginSnapshot | ZenXPluginMutationResult | void | null;

export function PluginSettings({
  onFeedback,
  onOpenGeneral,
}: {
  onFeedback?(message: string | null): void;
  onOpenGeneral?(pluginId: "computer" | "browser"): void;
}) {
  const { t } = useTranslation("settings");
  const [plugins, setPlugins] = useState<ZenXPluginSnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
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
    onFeedback?.(null);
    try {
      const result = await operation();
      if (result === null) return;
      const next =
        result !== undefined && "snapshot" in result ? result.snapshot : result;
      if (next !== undefined) setPlugins(next);
      setConfirmation(null);
      if (
        result !== undefined &&
        "capabilityRefresh" in result &&
        result.capabilityRefresh.status === "failed"
      ) {
        setError(
          t("pluginSettings.capabilityRefreshFailed", {
            success,
            error: result.capabilityRefresh.message,
          }),
        );
      } else {
        onFeedback?.(success);
      }
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(null);
    }
  };

  if (plugins === null) {
    return (
      <div className="page-card settings-card marketplace-state">
        <strong>{t("pluginSettings.loadingPlugins")}</strong>
        {error === null ? null : <span>{error}</span>}
      </div>
    );
  }

  return (
    <>
      <MarketplaceSettings
        plugins={plugins}
        onOpenGeneral={onOpenGeneral}
        busy={busy}
        confirmation={confirmation}
        setConfirmation={setConfirmation}
        run={run}
      />
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
  onOpenGeneral,
  busy,
  confirmation,
  setConfirmation,
  run,
}: {
  plugins: ZenXPluginSnapshot;
  onOpenGeneral?(pluginId: "computer" | "browser"): void;
  busy: string | null;
  confirmation: Confirmation | null;
  setConfirmation(value: Confirmation | null): void;
  run(
    key: string,
    operation: () => Promise<PluginOperationResult>,
    success: string,
  ): Promise<void>;
}) {
  const { t } = useTranslation("settings");
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
      i18n.t("settings:pluginSettings.pluginInstalledAndEnabled"),
    );
  };
  const selectTarball = async () => {
    await run(
      "install-tarball",
      async () => {
        const result = await window.zenx.plugins.selectTarball();
        return result.canceled ? null : result;
      },
      i18n.t("settings:pluginSettings.pluginTarballInstalledAndEnabled"),
    );
  };

  return (
    <section
      className="marketplace-section"
      aria-label={t("pluginSettings.marketplace")}
    >
      <div className="marketplace-rail">
        <label className="marketplace-search">
          <Icon name="search" />
          <span className="sr-only">{t("pluginSettings.searchPlugins")}</span>
          <input
            aria-label={t("pluginSettings.searchPlugins2")}
            placeholder={t("pluginSettings.searchNamePurposeOrPackage")}
            value={query}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          {query.length === 0 ? null : (
            <button type="button" onClick={() => setQuery("")}>
              {t("pluginSettings.clear")}
            </button>
          )}
        </label>
        <div
          className="marketplace-filters"
          aria-label={t("pluginSettings.pluginFilters")}
        >
          {(
            [
              ["all", t("pluginSettings.all")],
              ["installed", t("pluginSettings.installed")],
              ["built-in", t("pluginSettings.builtIn")],
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
          {t("pluginSettings.installFromSource")}
        </button>
      </div>

      {sourceOpen ? (
        <div
          id="plugin-source-panel"
          className="page-card plugin-source-install"
        >
          <div className="plugin-source-copy">
            <strong>{t("pluginSettings.installFromSource2")}</strong>
            <span>
              {t("pluginSettings.advancedPackageCodeIsTrustedToRunOnThis")}
            </span>
          </div>
          <label>
            {t("pluginSettings.source")}
            <Select
              aria-label={t("pluginSettings.pluginSource")}
              value={sourceMode}
              disabled={busy !== null}
              onValueChange={(value) =>
                setSourceMode(value as ZenXPluginPackageSource["mode"])
              }
            >
              <option value="npm">{t("pluginSettings.npmRegistry")}</option>
              <option value="git">{t("pluginSettings.gitCommitPinned")}</option>
              <option value="local-copy">
                {t("pluginSettings.localDirectoryCopy")}
              </option>
              <option value="dev-link">
                {t("pluginSettings.developmentLink")}
              </option>
            </Select>
          </label>
          <label>
            {t("pluginSettings.packageOrPath")}
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
              {busy === "install-tarball"
                ? t("pluginSettings.installing")
                : t("pluginSettings.chooseTarball")}
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={busy !== null || packageSpec.trim().length === 0}
              onClick={() => void installSource()}
            >
              {busy === "install-source"
                ? t("pluginSettings.installing")
                : t("pluginSettings.installSource")}
            </button>
          </div>
        </div>
      ) : null}

      {catalog?.error === undefined ? null : (
        <div className="marketplace-catalog-warning" role="alert">
          <Icon name="warning" />
          <div>
            <strong>{t("pluginSettings.externalCatalogUnavailable")}</strong>
            <span>
              {catalog.error} {t("pluginSettings.localPluginsRemainManageable")}
            </span>
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={() => setLoadAttempt((value) => value + 1)}
          >
            {t("pluginSettings.retry")}
          </button>
        </div>
      )}

      {catalog === null && inventory.length === 0 ? (
        <div className="page-card settings-card marketplace-state">
          <strong>{t("pluginSettings.loadingPlugins2")}</strong>
        </div>
      ) : entries.length === 0 ? (
        <div className="page-card settings-card marketplace-state">
          <strong>{t("pluginSettings.noPluginsFound")}</strong>
          <span>
            {query.trim().length === 0
              ? t("pluginSettings.noPluginsMatchThisFilter")
              : t("pluginSettings.tryADifferentSearch")}
          </span>
        </div>
      ) : (
        <div
          className="marketplace-list"
          aria-label={t("pluginSettings.plugins")}
        >
          {entries.map((entry) => (
            <MarketplaceInventoryCard
              key={entry.key}
              entry={entry}
              onOpenGeneral={onOpenGeneral}
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
  onOpenGeneral,
  busy,
  confirmation,
  setConfirmation,
  run,
}: {
  entry: MarketplaceInventoryViewEntry;
  onOpenGeneral?(pluginId: "computer" | "browser"): void;
  busy: string | null;
  confirmation: Confirmation | null;
  setConfirmation(value: Confirmation | null): void;
  run(
    key: string,
    operation: () => Promise<PluginOperationResult>,
    success: string,
  ): Promise<void>;
}) {
  const { t } = useTranslation("settings");
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
  const available =
    entry.available &&
    (plugin?.lifecycle === "uninstalled" || plugin?.available !== false);
  const displayLifecycle = available ? entry.lifecycle : "unavailable";
  const firstPartyAccess =
    entry.source === "built-in" &&
    (pluginId === "computer" || pluginId === "browser")
      ? pluginId
      : null;
  const [reviewingAccess, setReviewingAccess] = useState(
    firstPartyAccess !== null && active,
  );
  const activationButtonRef = useRef<HTMLButtonElement>(null);
  const accessPanelRef = useRef<HTMLDivElement>(null);
  const focusAccessAfterOpen = useRef(false);
  const accessPanelId = `plugin-access-${pluginId}`;
  const openAccessReview = () => {
    focusAccessAfterOpen.current = true;
    setReviewingAccess(true);
  };
  useEffect(() => {
    if (!reviewingAccess || !focusAccessAfterOpen.current) return;
    focusAccessAfterOpen.current = false;
    accessPanelRef.current?.focus();
    accessPanelRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [reviewingAccess]);
  const source =
    entry.source === "built-in"
      ? i18n.t("settings:pluginSettings.builtIn")
      : entry.source === "catalog"
        ? t("pluginSettings.marketplace")
        : plugin?.profileSource === undefined
          ? i18n.t("settings:pluginSettings.installedSource")
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
        ? t("pluginSettings.namedVersionInstalled", {
            name: entry.name,
            version: selectedVersion,
          })
        : t("pluginSettings.namedVersionUpdated", {
            name: entry.name,
            version: selectedVersion,
          }),
    );
  };

  const activateFirstParty = async () => {
    if (firstPartyAccess === null || pluginId === undefined) return;
    if (entry.lifecycle === "available") {
      await run(
        `install-built-in:${pluginId}`,
        () => window.zenx.plugins.installBuiltIn(pluginId),
        t("pluginSettings.namedInstalled", { name: entry.name }),
      );
    } else if (entry.lifecycle === "uninstalled") {
      await run(
        `reinstall:${pluginId}`,
        () => window.zenx.plugins.reinstall(pluginId),
        `${entry.name} reinstalled.`,
      );
    } else {
      await run(
        `enable:${pluginId}`,
        () => window.zenx.plugins.setEnabled(pluginId, true),
        `${entry.name} enabled.`,
      );
    }
  };

  return (
    <article
      className="page-card marketplace-card"
      data-lifecycle={entry.lifecycle}
      data-available={available}
      data-source={entry.source}
    >
      <span className="plugin-icon marketplace-icon" aria-hidden="true">
        <Icon name={marketplaceIcon(entry.icon)} />
      </span>
      <div className="plugin-lifecycle-copy">
        <div className="plugin-title-line">
          <h3>{entry.name}</h3>
          <span className="plugin-source-badge">{source}</span>
          <span className={`plugin-status status-${displayLifecycle}`}>
            {lifecycleLabel(displayLifecycle)}
          </span>
          {entry.updateAvailable ? (
            <span className="plugin-status status-update">
              {t("pluginSettings.updateAvailable")}
            </span>
          ) : null}
        </div>
        <p>{entry.description}</p>
        <details>
          <summary>{t("pluginSettings.pluginDetails")}</summary>
          <small>
            {entry.packageSpec ?? pluginId}
            {plugin === undefined ? "" : ` · v${plugin.version}`}
          </small>
        </details>
        {entry.unavailableReason === undefined ? null : (
          <div className="plugin-unavailable" role="note">
            <Icon name="warning" />
            <span>{entry.unavailableReason}</span>
          </div>
        )}
        {available || plugin?.unavailableReason === undefined ? null : (
          <div className="plugin-unavailable" role="note">
            <Icon name="warning" />
            <div>
              <span>{t("pluginSettings.couldNotLoadThisPlugin")}</span>
              <details>
                <summary>{t("pluginSettings.errorDetails")}</summary>
                <span>{plugin.unavailableReason}</span>
              </details>
            </div>
          </div>
        )}
      </div>
      <div className="plugin-actions" aria-label={`${entry.name} actions`}>
        {entry.source === "catalog" && entry.versions.length > 0 ? (
          <label className="marketplace-version">
            <span className="sr-only">
              {entry.name} {t("pluginSettings.version")}
            </span>
            <Select
              aria-label={`${entry.name} version`}
              value={selectedVersion}
              disabled={busy !== null}
              onValueChange={(value) => setSelectedVersion(value)}
            >
              {entry.versions.map((version) => (
                <option key={version.version} value={version.version}>
                  v{version.version}
                  {version.version === entry.recommendedVersion
                    ? " · recommended"
                    : ""}
                </option>
              ))}
            </Select>
          </label>
        ) : null}

        {entry.lifecycle === "unavailable" ? null : entry.lifecycle ===
          "available" ? (
          <button
            ref={firstPartyAccess === null ? undefined : activationButtonRef}
            className="primary-button"
            type="button"
            disabled={busy !== null}
            aria-expanded={
              firstPartyAccess === null ? undefined : reviewingAccess
            }
            aria-controls={
              firstPartyAccess === null ? undefined : accessPanelId
            }
            onClick={() =>
              void (firstPartyAccess !== null
                ? openAccessReview()
                : entry.source === "built-in" && pluginId !== undefined
                  ? run(
                      `install-built-in:${pluginId}`,
                      () => window.zenx.plugins.installBuiltIn(pluginId),
                      t("pluginSettings.namedInstalled", { name: entry.name }),
                    )
                  : installCatalogVersion())
            }
          >
            {busy === `marketplace:${entry.packageSpec}` ||
            busy === `install-built-in:${pluginId}`
              ? t("pluginSettings.installing")
              : selectedVersion.length === 0
                ? t("pluginSettings.install")
                : t("pluginSettings.installVersion", {
                    version: selectedVersion,
                  })}
          </button>
        ) : entry.lifecycle === "uninstalled" && pluginId !== undefined ? (
          <button
            ref={firstPartyAccess === null ? undefined : activationButtonRef}
            className="primary-button"
            type="button"
            disabled={busy !== null || !available}
            aria-expanded={
              firstPartyAccess === null ? undefined : reviewingAccess
            }
            aria-controls={
              firstPartyAccess === null ? undefined : accessPanelId
            }
            onClick={() =>
              void (firstPartyAccess !== null
                ? openAccessReview()
                : run(
                    `reinstall:${pluginId}`,
                    () => window.zenx.plugins.reinstall(pluginId),
                    `${entry.name} reinstalled.`,
                  ))
            }
          >
            {busy === `reinstall:${pluginId}`
              ? t("pluginSettings.reinstalling")
              : t("pluginSettings.reinstall")}
          </button>
        ) : pluginId === undefined ? null : (
          <>
            <button
              ref={
                firstPartyAccess === null || active
                  ? undefined
                  : activationButtonRef
              }
              className="secondary-button"
              type="button"
              disabled={busy !== null || (!available && !active)}
              aria-expanded={
                firstPartyAccess === null || active
                  ? undefined
                  : reviewingAccess
              }
              aria-controls={
                firstPartyAccess === null || active ? undefined : accessPanelId
              }
              title={
                !available && !active ? entry.unavailableReason : undefined
              }
              onClick={() =>
                void (!active && firstPartyAccess !== null
                  ? openAccessReview()
                  : run(
                      `enable:${pluginId}`,
                      () => window.zenx.plugins.setEnabled(pluginId, !active),
                      t("pluginSettings.namedToggled", {
                        name: entry.name,
                        state: active
                          ? t("pluginSettings.disabledLower")
                          : t("pluginSettings.enabledLower"),
                      }),
                    ))
              }
            >
              {busy === `enable:${pluginId}`
                ? t("pluginSettings.applying")
                : active
                  ? t("pluginSettings.disable")
                  : t("pluginSettings.enable")}
            </button>
            {firstPartyAccess === null || !active ? null : (
              <button
                ref={activationButtonRef}
                className="secondary-button"
                type="button"
                aria-expanded={reviewingAccess}
                aria-controls={accessPanelId}
                onClick={openAccessReview}
              >
                {t("pluginSettings.reviewAccess")}
              </button>
            )}
            {entry.source === "catalog" &&
            plugin?.version !== selectedVersion ? (
              <button
                className="primary-button"
                type="button"
                disabled={busy !== null}
                onClick={() => void installCatalogVersion()}
              >
                {busy === `marketplace:${entry.packageSpec}`
                  ? t("pluginSettings.updating")
                  : t("pluginSettings.updateVersion", {
                      version: selectedVersion,
                    })}
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
                    t("pluginSettings.namedUpdated", { name: entry.name }),
                  )
                }
              >
                {busy === `update:${pluginId}`
                  ? t("pluginSettings.opening")
                  : t("pluginSettings.update")}
              </button>
            ) : null}
          </>
        )}

        {pluginId !== undefined && plugin !== undefined ? (
          <ActionMenu
            label={t("pluginSettings.managePlugin", { name: entry.name })}
            items={[
              ...(entry.lifecycle !== "uninstalled"
                ? [
                    {
                      label: t("pluginSettings.uninstall"),
                      disabled: busy !== null,
                      description: t(
                        "pluginSettings.removeThePluginKeepItsSavedData",
                      ),
                      onSelect: () =>
                        setConfirmation({
                          pluginId,
                          action: "uninstall" as const,
                        }),
                    },
                  ]
                : []),
              {
                label: t("pluginSettings.deleteData"),
                disabled: busy !== null || active,
                danger: true,
                description: active
                  ? t("pluginSettings.disableThePluginBeforeDeletingItsData")
                  : t("pluginSettings.permanentlyDeleteThisPluginSSavedData"),
                onSelect: () =>
                  setConfirmation({ pluginId, action: "delete-data" }),
              },
            ]}
          />
        ) : null}
      </div>
      {firstPartyAccess !== null && !reviewingAccess ? (
        <div id={accessPanelId} hidden />
      ) : null}
      {firstPartyAccess !== null && reviewingAccess ? (
        <div
          id={accessPanelId}
          ref={accessPanelRef}
          className="plugin-access-wrap"
          role="group"
          aria-label={t("pluginSettings.namedAccessDetails", {
            name: entry.name,
          })}
          tabIndex={-1}
        >
          <PluginAccessReview
            pluginId={firstPartyAccess}
            permissions={plugin?.permissions ?? entry.permissions ?? []}
            onOpenGeneral={onOpenGeneral}
          />
          <div className="plugin-access-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setReviewingAccess(false);
                activationButtonRef.current?.focus();
              }}
            >
              {t("pluginSettings.closeDetails")}
            </button>
            {active ? null : (
              <button
                type="button"
                className="primary-button"
                disabled={
                  busy !== null ||
                  !available ||
                  (plugin?.permissions ?? entry.permissions ?? []).length === 0
                }
                onClick={() => void activateFirstParty()}
              >
                {busy === null
                  ? t("pluginSettings.continueEnabling", { name: entry.name })
                  : t("pluginSettings.applying")}
              </button>
            )}
          </div>
        </div>
      ) : null}
      {confirming ? (
        <div
          className="plugin-confirm"
          role="group"
          aria-label={t("pluginSettings.confirmAction", { action: confirming })}
        >
          <p>
            {confirming === "uninstall"
              ? t("pluginSettings.uninstallThisPluginAndItsToolsItsDataStays")
              : t(
                  "pluginSettings.permanentlyDeleteThisPluginSSavedDataYourConversations",
                )}
          </p>
          <div>
            <button
              type="button"
              className="secondary-button"
              autoFocus
              onClick={() => setConfirmation(null)}
            >
              {t("pluginSettings.cancel")}
            </button>
            <button
              type="button"
              className="danger-button"
              onClick={() =>
                void run(
                  `${confirming}:${pluginId}`,
                  () =>
                    confirming === "uninstall"
                      ? window.zenx.plugins.uninstall(pluginId!)
                      : window.zenx.plugins.deleteData(pluginId!),
                  confirming === "uninstall"
                    ? t("pluginSettings.namedUninstalled", { name: entry.name })
                    : t("pluginSettings.namedDataDeleted", {
                        name: entry.name,
                      }),
                )
              }
            >
              {confirming === "uninstall"
                ? t("pluginSettings.confirmUninstall")
                : t("pluginSettings.confirmDeleteData")}
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
      return i18n.t("settings:pluginSettings.builtIn");
    case "npm":
      return i18n.t("settings:pluginSettings.npmRegistry");
    case "git":
      return i18n.t("settings:pluginSettings.commitPinnedGit");
    case "tarball":
      return i18n.t("settings:pluginSettings.tarball");
    case "local-copy":
      return i18n.t("settings:pluginSettings.localDirectorySnapshot");
    case "dev-link":
      return i18n.t("settings:pluginSettings.developmentLink");
  }
}

function sourcePlaceholder(mode: ZenXPluginPackageSource["mode"]): string {
  switch (mode) {
    case "bundled":
      return i18n.t("settings:pluginSettings.appResourcePackage");
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
      return i18n.t("settings:pluginSettings.enabled");
    case "installed":
      return i18n.t("settings:pluginSettings.disabled");
    case "uninstalled":
      return i18n.t("settings:pluginSettings.uninstalled");
    case "available":
      return i18n.t("settings:pluginSettings.available");
    case "unavailable":
      return i18n.t("settings:pluginSettings.unavailable");
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
