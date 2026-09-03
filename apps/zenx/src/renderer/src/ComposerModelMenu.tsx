import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import type { ZenXProviderProfile } from "../../main/host-profile.js";
import type { ModelSummary } from "../../protocol-client/index.js";
import { Icon } from "./icons.js";
import {
  canSendWithModel,
  groupedModelOptions,
  reasoningOptions,
} from "./model-settings.js";

type MenuPanel = "root" | "model" | "reasoning";

export function ComposerModelMenu({
  disabled,
  modelError,
  models,
  onModelChange,
  onReasoningChange,
  providerProfiles,
  selectedModel,
  selectedReasoningEffort,
  switching,
}: {
  disabled: boolean;
  modelError: string | null;
  models: readonly ModelSummary[];
  onModelChange(model: string): void;
  onReasoningChange(effort: string): void;
  providerProfiles: readonly ZenXProviderProfile[];
  selectedModel: string;
  selectedReasoningEffort: string | null;
  switching: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);
  const [panel, setPanel] = useState<MenuPanel | null>(null);
  const selected = models.find((model) => model.id === selectedModel);
  const available = canSendWithModel(models, selectedModel);
  const groups = groupedModelOptions(models, providerProfiles);
  const efforts = reasoningOptions(models, selectedModel);
  const currentModelLabel = selected?.displayName ?? "Unavailable model";
  const selectedReasoningLabel =
    selected === undefined ||
    efforts.length === 0 ||
    selectedReasoningEffort === null
      ? null
      : formatReasoningEffort(selectedReasoningEffort);
  const currentSelectionLabel =
    selectedReasoningLabel === null
      ? currentModelLabel
      : `${currentModelLabel} ${selectedReasoningLabel}`;
  const reasoningLabel =
    selected === undefined
      ? "Unknown"
      : efforts.length === 0
        ? "Text only"
        : (selectedReasoningLabel ?? "Choose");
  const close = (restoreFocus = true) => {
    restoreFocusRef.current = restoreFocus;
    setPanel(null);
  };

  useEffect(() => {
    if (panel === null) return;
    const closeOutside = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [panel]);
  useEffect(() => {
    if (disabled || switching) setPanel(null);
  }, [disabled, switching]);
  useEffect(() => {
    if (panel === null) return;
    enabledMenuItems(menuRef.current).at(0)?.focus();
  }, [panel]);
  useLayoutEffect(() => {
    if (panel !== null || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    triggerRef.current?.focus();
  }, [panel]);

  const selectModel = (model: string) => {
    onModelChange(model);
    close();
  };
  const selectEffort = (effort: string) => {
    onReasoningChange(effort);
    close();
  };
  return (
    <div className="composer-model-menu" ref={containerRef}>
      <button
        ref={triggerRef}
        className={`composer-model-trigger${available ? "" : " unavailable"}`}
        type="button"
        aria-describedby={
          modelError === null ? undefined : "composer-model-error"
        }
        aria-expanded={panel !== null}
        aria-haspopup="menu"
        aria-label={`Model and reasoning: ${currentSelectionLabel}`}
        title={currentSelectionLabel}
        disabled={disabled || switching}
        onClick={() => {
          panel === null ? setPanel("root") : close();
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          setPanel("root");
        }}
      >
        <span>{switching ? "Changing…" : currentSelectionLabel}</span>
        <Icon name="chevron-down" size={12} />
      </button>
      {panel === null ? null : (
        <div
          ref={menuRef}
          className="composer-selection-menu"
          role="menu"
          aria-label={
            panel === "root"
              ? "Model and reasoning"
              : panel === "model"
                ? "Choose model"
                : "Choose reasoning effort"
          }
          onKeyDown={(event) =>
            handleMenuKeyDown(event, panel, setPanel, close)
          }
        >
          {panel === "root" ? (
            <>
              <MenuEntry
                label="Model"
                value={currentModelLabel}
                onClick={() => setPanel("model")}
              />
              <MenuEntry
                disabled={efforts.length === 0}
                label="Reasoning"
                value={reasoningLabel}
                onClick={() => setPanel("reasoning")}
              />
              {available ? (
                <p className="composer-menu-note">
                  {efforts.length === 0
                    ? "This model sends text without a Provider-specific reasoning control. Configure or detect capabilities to enable one."
                    : "Changes apply to the next turn."}
                </p>
              ) : (
                <p className="composer-menu-warning" role="alert">
                  This model cannot run. Choose another model before sending.
                </p>
              )}
            </>
          ) : panel === "model" ? (
            <>
              <MenuBack label="Model" onClick={() => setPanel("root")} />
              <div className="composer-menu-scroll">
                {groups.map((group) => (
                  <div
                    className="composer-model-group"
                    key={group.providerProfileId}
                    role="group"
                    aria-label={group.displayName}
                  >
                    <p>{group.displayName}</p>
                    {group.models.map((model) => (
                      <button
                        key={model.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={model.id === selectedModel}
                        onClick={() => selectModel(model.id)}
                      >
                        <span>
                          <strong>{model.displayName}</strong>
                          <small>{capabilityLabel(model)}</small>
                        </span>
                        {model.id === selectedModel ? (
                          <Icon name="check" size={13} />
                        ) : null}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <MenuBack label="Reasoning" onClick={() => setPanel("root")} />
              {efforts.map((effort) => (
                <button
                  className="composer-effort-option"
                  key={effort.reasoningEffort}
                  type="button"
                  role="menuitemradio"
                  aria-checked={
                    effort.reasoningEffort === selectedReasoningEffort
                  }
                  onClick={() => selectEffort(effort.reasoningEffort)}
                >
                  <span>
                    <strong>
                      {formatReasoningEffort(effort.reasoningEffort)}
                    </strong>
                    {effort.description === effort.reasoningEffort ? null : (
                      <small>{effort.description}</small>
                    )}
                  </span>
                  {effort.reasoningEffort === selectedReasoningEffort ? (
                    <Icon name="check" size={13} />
                  ) : null}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MenuEntry({
  disabled = false,
  label,
  value,
  onClick,
}: {
  disabled?: boolean;
  label: string;
  value: string;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-haspopup="menu"
      disabled={disabled}
      onClick={onClick}
    >
      <span>
        <strong>{label}</strong>
        <small>{value}</small>
      </span>
      <Icon name="chevron-right" size={13} />
    </button>
  );
}

function MenuBack({ label, onClick }: { label: string; onClick(): void }) {
  return (
    <button
      className="composer-menu-back"
      type="button"
      role="menuitem"
      onClick={onClick}
    >
      <Icon name="chevron-left" size={13} />
      <strong>{label}</strong>
    </button>
  );
}

function capabilityLabel(model: ModelSummary): string {
  const modalities = model.inputModalities.includes("image")
    ? "Text + images"
    : "Text";
  return `${modalities} · ${model.supportedReasoningEfforts.length} reasoning ${
    model.supportedReasoningEfforts.length === 1 ? "level" : "levels"
  }`;
}

function formatReasoningEffort(effort: string): string {
  if (effort === "xhigh") return "Extra High";
  return effort
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function handleMenuKeyDown(
  event: ReactKeyboardEvent<HTMLDivElement>,
  panel: MenuPanel,
  setPanel: (panel: MenuPanel) => void,
  close: (restoreFocus?: boolean) => void,
) {
  if (event.key === "Escape") {
    event.preventDefault();
    close();
    return;
  }
  if (event.key === "Tab") {
    close(false);
    return;
  }
  if (event.key === "ArrowLeft" && panel !== "root") {
    event.preventDefault();
    setPanel("root");
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = enabledMenuItems(event.currentTarget);
  if (items.length === 0) return;
  event.preventDefault();
  const currentIndex = items.indexOf(
    document.activeElement as HTMLButtonElement,
  );
  const nextIndex =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : currentIndex === -1
          ? event.key === "ArrowUp"
            ? items.length - 1
            : 0
          : event.key === "ArrowUp"
            ? (currentIndex - 1 + items.length) % items.length
            : (currentIndex + 1) % items.length;
  items[nextIndex]?.focus();
}

function enabledMenuItems(root: HTMLElement | null): HTMLButtonElement[] {
  return root === null
    ? []
    : Array.from(
        root.querySelectorAll<HTMLButtonElement>(
          '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)',
        ),
      );
}
