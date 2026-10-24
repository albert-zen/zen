import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ExternalApplicationCatalog,
  ExternalApplicationId,
} from "../../main/workspace-external-open.js";
import { ActionMenu, Dialog } from "./ui/controls.js";
import { Icon } from "./icons.js";

type Props = {
  threadId: string;
  path: string;
  disabled: boolean;
  onError(message: string): void;
};

// File changes retire the menu, dialog and every in-flight UI result together.
export function WorkspaceExternalOpen(props: Props) {
  return (
    <ExternalOpenActions
      key={JSON.stringify([props.threadId, props.path])}
      {...props}
    />
  );
}

function ExternalOpenActions({ threadId, path, disabled, onError }: Props) {
  const { t } = useTranslation("panels");
  const [catalog, setCatalog] = useState<ExternalApplicationCatalog>();
  const [busy, setBusy] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [managementError, setManagementError] = useState("");
  const managementVisible = useRef(manageOpen);
  managementVisible.current = manageOpen;
  const context = useRef(0);
  const dialogGeneration = useRef(0);
  const dialogTrigger = useRef<HTMLButtonElement | null>(null);
  const pending = useRef(false);
  const catalogSequence = useRef(0);
  const refreshCatalog = () => {
    if (pending.current) return;
    const generation = context.current;
    const request = ++catalogSequence.current;
    void window.zenx.workspaceFiles.applications().then(
      (value) => {
        if (
          generation === context.current &&
          request === catalogSequence.current
        )
          setCatalog(value);
      },
      (error) => {
        if (
          generation === context.current &&
          request === catalogSequence.current
        )
          onError(String(error));
      },
    );
  };
  useEffect(() => {
    context.current++;
    pending.current = false;
    setBusy(false);
    setCatalog(undefined);
    refreshCatalog();
    return () => {
      context.current++;
    };
  }, [threadId, path]);
  const perform = async (
    action: () => Promise<unknown>,
    configuring = false,
  ) => {
    if (pending.current) return;
    const generation = context.current;
    pending.current = true;
    setBusy(true);
    if (configuring) setManagementError("");
    try {
      await action();
    } catch (error) {
      if (generation === context.current) {
        const message = error instanceof Error ? error.message : String(error);
        if (configuring) setManagementError(message);
        if (!configuring || !managementVisible.current) onError(message);
      }
    } finally {
      if (generation === context.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  const labels: Record<ExternalApplicationId, string> = {
    vscode: "VS Code",
    cursor: "Cursor",
    editor: t("externalTextEditor"),
    custom: t("externalCustomApp"),
  };
  const open = (application: "reveal" | "default" | ExternalApplicationId) =>
    void perform(() =>
      window.zenx.workspaceFiles.openExternal({
        host: "local",
        threadId,
        path,
        application,
      }),
    );
  const configure = (id: ExternalApplicationId, reset = false) =>
    void perform(async () => {
      const generation = context.current;
      const request = ++catalogSequence.current;
      const updated = await window.zenx.workspaceFiles.configureApplication(
        id,
        reset,
      );
      if (generation === context.current && request === catalogSequence.current)
        setCatalog(updated);
    }, true);
  const applications = ["vscode", "cursor", "editor", "custom"] as const;
  return (
    <>
      <ActionMenu
        compact
        onOpen={refreshCatalog}
        triggerIcon={<Icon name="external-link" />}
        label={t("externalFileOpen")}
        items={[
          {
            label: t(
              catalog?.platform === "darwin"
                ? "externalRevealFinder"
                : catalog?.platform === "win32"
                  ? "externalRevealExplorer"
                  : "externalRevealManager",
            ),
            disabled: busy,
            onSelect: (trigger: HTMLButtonElement | null) => {
              trigger?.focus();
              open("reveal");
            },
          },
          {
            label: t("externalDefaultApp"),
            disabled: busy || disabled,
            description: disabled ? t("externalSaveFirst") : undefined,
            onSelect: (trigger: HTMLButtonElement | null) => {
              trigger?.focus();
              open("default");
            },
          },
          ...applications
            .filter((id) => catalog?.applications[id])
            .map((id) => ({
              label: t("externalOpenWith", { app: labels[id] }),
              disabled: busy || disabled || !catalog?.applications[id],
              onSelect: (trigger: HTMLButtonElement | null) => {
                trigger?.focus();
                open(id);
              },
            })),
          {
            label: t("externalManageApps"),
            onSelect: (trigger: HTMLButtonElement | null) => {
              trigger?.focus();
              dialogTrigger.current = trigger;
              dialogGeneration.current = context.current;
              setManageOpen(true);
            },
          },
        ]}
      />
      <Dialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        title={t("externalManageTitle")}
        className="external-applications-dialog"
        restoreFocus={() =>
          dialogGeneration.current === context.current &&
          !!dialogTrigger.current?.getClientRects().length
        }
      >
        <header className="external-applications-header">
          <h2>{t("externalManageTitle")}</h2>
          <button
            type="button"
            className="quiet-button"
            onClick={() => setManageOpen(false)}
          >
            {t("externalManageClose")}
          </button>
        </header>
        <div className="external-applications-body">
          <p className="external-applications-hint">
            {t("externalManagePersistence")}
          </p>
          {managementError ? (
            <p role="alert" className="external-applications-error">
              {managementError}
            </p>
          ) : null}
          {busy ? <p role="status">{t("externalManageBusy")}</p> : null}
          {applications.map((id) => (
            <section
              className="external-application"
              key={id}
              aria-label={labels[id]}
            >
              <h3>{labels[id]}</h3>
              {catalog?.applications[id] ? (
                <details>
                  <summary>{t("externalApplicationPath")}</summary>
                  <p className="external-application-path">
                    {catalog.applications[id]}
                  </p>
                </details>
              ) : (
                <p className="external-application-missing">
                  {t("externalNotConfigured")}
                </p>
              )}
              <button
                type="button"
                className="quiet-button"
                disabled={busy}
                onClick={() => configure(id)}
              >
                {t("externalChooseApp", { app: labels[id] })}
              </button>
              {id === "custom" && catalog?.applications.custom ? (
                <button
                  type="button"
                  className="quiet-button"
                  disabled={busy}
                  onClick={() => configure("custom", true)}
                >
                  {t("externalResetCustom")}
                </button>
              ) : null}
            </section>
          ))}
        </div>
      </Dialog>
    </>
  );
}
