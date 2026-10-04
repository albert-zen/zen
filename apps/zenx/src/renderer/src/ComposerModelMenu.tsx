import {
  agentProviderLabel,
  useAgentProviderSelection,
} from "./agent-provider-selection.js";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/controls.js";
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

type MenuPanel = "root" | "engine" | "model" | "reasoning";

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
  loading = false,
  modelSelectionDisabled = false,
  showReasoning = true,
  onRetryModels,
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
  loading?: boolean;
  modelSelectionDisabled?: boolean;
  showReasoning?: boolean;
  onRetryModels?(): void;
}) {
  const engineSelection = useAgentProviderSelection();
  const selectedEngine = engineSelection?.instances.find(
    (instance) => instance.id === engineSelection.value,
  );
  const engineLabel = selectedEngine
    ? agentProviderLabel(selectedEngine)
    : engineSelection?.value;
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);
  const [panel, setPanel] = useState<MenuPanel | null>(null);
  const lastPanel = useRef<MenuPanel>("root");
  if (panel !== null) lastPanel.current = panel;
  const visiblePanel = panel ?? lastPanel.current;
  const [query, setQuery] = useState("");
  const selected = models.find((model) => model.id === selectedModel);
  const available = canSendWithModel(models, selectedModel);
  const nativeModels =
    selectedEngine !== undefined && selectedEngine.kind !== "zen";
  const modelGroups = nativeModels
    ? [
        {
          providerProfileId: selectedEngine.id,
          displayName: agentProviderLabel(selectedEngine),
          models: models.filter((model) => !model.hidden),
        },
      ]
    : groupedModelOptions(models, providerProfiles);
  const groups = modelGroups
    .map((group) => ({
      ...group,
      models: group.models.filter((model) =>
        `${model.displayName} ${group.displayName}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase()),
      ),
    }))
    .filter((group) => group.models.length > 0);
  const efforts = reasoningOptions(models, selectedModel);
  const currentModelLabel =
    selected?.displayName ??
    (loading
      ? "Loading models…"
      : nativeModels
        ? selectedModel || "Choose model"
        : "Unavailable model");
  const selectedReasoningLabel =
    !showReasoning ||
    selected === undefined ||
    efforts.length === 0 ||
    selectedReasoningEffort === null
      ? null
      : formatReasoningEffort(selectedReasoningEffort);
  const currentSelectionLabel =
    selectedReasoningLabel === null
      ? currentModelLabel
      : `${currentModelLabel} ${selectedReasoningLabel}`;
  const currentScopeLabel = engineLabel
    ? `${engineLabel} · ${currentSelectionLabel}`
    : currentSelectionLabel;
  const reasoningLabel =
    selected === undefined
      ? "Unknown"
      : efforts.length === 0
        ? "Text only"
        : (selectedReasoningLabel ?? "Choose");
  const close = (restoreFocus = true) => {
    restoreFocusRef.current = restoreFocus;
    setPanel(null);
    setQuery("");
  };

  useEffect(() => {
    if (disabled || switching) setPanel(null);
  }, [disabled, switching]);
  useEffect(() => {
    if (panel === null) return;
    if (panel === "model") menuRef.current?.querySelector("input")?.focus();
    else enabledMenuItems(menuRef.current).at(0)?.focus();
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
    <Popover
      open={panel !== null}
      onOpenChange={(open) => (open ? setPanel("root") : close(false))}
    >
      <div className="composer-model-menu" ref={containerRef}>
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            className={`composer-model-trigger${available ? "" : " unavailable"}`}
            type="button"
            aria-describedby={
              modelError === null ? undefined : "composer-model-error"
            }
            aria-expanded={panel !== null}
            aria-haspopup="menu"
            aria-label={
              engineLabel
                ? `Agent Provider and model: ${currentScopeLabel}`
                : `Model and reasoning: ${currentSelectionLabel}`
            }
            title={currentScopeLabel}
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
            {engineLabel ? (
              <span className="composer-engine-mark" aria-hidden="true">
                <Icon
                  name={
                    selectedEngine?.kind === "codex" ||
                    selectedEngine?.kind === "opencode"
                      ? "terminal"
                      : "layers"
                  }
                  size={13}
                />
              </span>
            ) : null}
            <span className="composer-selection-label">
              {switching ? "Changing…" : currentSelectionLabel}
            </span>
            <Icon name="chevron-down" size={12} />
          </button>
        </PopoverTrigger>
        <PopoverContent
          ref={menuRef}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            enabledMenuItems(menuRef.current).at(0)?.focus();
          }}
          onCloseAutoFocus={(event) => event.preventDefault()}
          className="composer-selection-menu"
          role="menu"
          aria-label={
            visiblePanel === "root"
              ? engineLabel
                ? "Agent Provider and model"
                : "Model and reasoning"
              : visiblePanel === "engine"
                ? "Choose Agent Provider"
                : visiblePanel === "model"
                  ? "Choose model"
                  : "Choose reasoning effort"
          }
          onKeyDown={(event) => {
            if (event.key === "Tab") triggerRef.current?.focus();
            handleMenuKeyDown(event, visiblePanel, setPanel, close);
          }}
        >
          {visiblePanel === "root" ? (
            <>
              {engineSelection === null ? null : (
                <MenuEntry
                  label="Agent Provider"
                  value={engineLabel ?? "Unavailable instance"}
                  disabled={
                    !engineSelection.onChange || engineSelection.disabled
                  }
                  onClick={() => setPanel("engine")}
                />
              )}
              <MenuEntry
                disabled={loading || modelSelectionDisabled}
                label="Model"
                value={currentModelLabel}
                onClick={() => setPanel("model")}
              />
              {showReasoning ? (
                <MenuEntry
                  disabled={efforts.length === 0}
                  label="Reasoning"
                  value={reasoningLabel}
                  onClick={() => setPanel("reasoning")}
                />
              ) : null}
              {modelError === null ? null : (
                <p className="composer-menu-warning" role="alert">
                  {modelError}
                </p>
              )}
              {onRetryModels === undefined ? null : (
                <button type="button" role="menuitem" onClick={onRetryModels}>
                  Retry models
                </button>
              )}
              {loading ? (
                <p className="composer-menu-note" role="status">
                  Loading this Agent Provider’s models…
                </p>
              ) : available ? (
                <p className="composer-menu-note">
                  {showReasoning && efforts.length === 0
                    ? "This model sends text without a Provider-specific reasoning control. Configure or detect capabilities to enable one."
                    : "Changes apply to the next turn."}
                </p>
              ) : (
                <p className="composer-menu-warning" role="alert">
                  This model cannot run. Choose another model before sending.
                </p>
              )}
            </>
          ) : visiblePanel === "engine" ? (
            <>
              <MenuBack
                label="Agent Provider"
                onClick={() => setPanel("root")}
              />
              <div className="composer-menu-scroll">
                {engineSelection?.instances.map((instance) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={instance.id === engineSelection.value}
                    data-agent-provider-id={instance.id}
                    key={instance.id}
                    disabled={engineSelection.disabled}
                    onClick={() => {
                      engineSelection.onChange?.(instance.id);
                      close();
                    }}
                  >
                    <span>
                      <strong>{agentProviderLabel(instance)}</strong>
                    </span>
                    {instance.id === engineSelection.value ? (
                      <Icon name="check" size={13} />
                    ) : null}
                  </button>
                ))}
              </div>
            </>
          ) : visiblePanel === "model" ? (
            <>
              <MenuBack
                label="Model"
                onClick={() => {
                  setQuery("");
                  setPanel("root");
                }}
              />
              <input
                className="composer-model-search"
                aria-label="Search models"
                placeholder="Search models…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key !== "Escape" &&
                    event.key !== "ArrowDown" &&
                    event.key !== "ArrowUp" &&
                    event.key !== "Tab"
                  )
                    event.stopPropagation();
                }}
              />
              {groups.length === 0 ? (
                <p className="composer-menu-note" role="status">
                  No matching models.
                </p>
              ) : null}
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
                        data-model-id={model.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={model.id === selectedModel}
                        onClick={() => selectModel(model.id)}
                      >
                        <span>
                          <strong>{model.displayName}</strong>
                          <small>
                            {showReasoning
                              ? capabilityLabel(model)
                              : model.description || "Native model"}
                          </small>
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
        </PopoverContent>
      </div>
    </Popover>
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
