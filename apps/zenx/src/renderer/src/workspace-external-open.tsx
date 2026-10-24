import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ExternalApplicationCatalog,
  ExternalApplicationId,
} from "../../main/workspace-external-open.js";
import { ActionMenu } from "./ui/controls.js";
import { Icon } from "./icons.js";

export function WorkspaceExternalOpen({
  threadId,
  path,
  disabled,
  onError,
}: {
  threadId: string;
  path: string;
  disabled: boolean;
  onError(message: string): void;
}) {
  const { t } = useTranslation("panels");
  const [catalog, setCatalog] = useState<ExternalApplicationCatalog>();
  const [busy, setBusy] = useState(false);
  const context = useRef(0);
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
    refreshCatalog();
    return () => {
      context.current++;
    };
  }, [threadId, path]);
  const perform = async (action: () => Promise<unknown>) => {
    if (pending.current) return;
    const generation = context.current;
    pending.current = true;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      if (generation === context.current)
        onError(error instanceof Error ? error.message : String(error));
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
    });
  return (
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
        ...(["vscode", "cursor", "editor", "custom"] as const).map((id) => ({
          label: t("externalOpenWith", { app: labels[id] }),
          disabled: busy || disabled || !catalog?.applications[id],
          description: catalog?.applications[id] ?? t("externalNotConfigured"),
          onSelect: (trigger: HTMLButtonElement | null) => {
            trigger?.focus();
            open(id);
          },
        })),
        ...(["vscode", "cursor", "editor", "custom"] as const).map((id) => ({
          label: t("externalChooseApp", { app: labels[id] }),
          disabled: busy,
          onSelect: (trigger: HTMLButtonElement | null) => {
            trigger?.focus();
            configure(id);
          },
        })),
        {
          label: t("externalResetCustom"),
          disabled: busy || !catalog?.applications.custom,
          onSelect: (trigger: HTMLButtonElement | null) => {
            trigger?.focus();
            configure("custom", true);
          },
        },
      ]}
    />
  );
}
