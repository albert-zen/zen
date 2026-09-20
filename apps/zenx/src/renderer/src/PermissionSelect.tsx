import { Popover, PopoverTrigger, PopoverContent } from "./ui/controls.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FilePermissionMode } from "../../protocol-client/types.js";
import { Icon } from "./icons.js";

export const permissionLabels: Record<FilePermissionMode, string> = {
  "read-only": "Read only",
  "workspace-write": "Workspace write",
  "danger-full-access": "Full access",
};
const permissionDescriptions: Record<FilePermissionMode, string> = {
  "read-only": "Read files without changing them",
  "workspace-write": "Edit files inside this project",
  "danger-full-access": "Run tools and edit files without approval",
};
export function PermissionSelect({
  value,
  disabled,
  switching,
  error,
  legacyApproval = false,
  onChange,
}: {
  value: FilePermissionMode;
  legacyApproval?: boolean;
  disabled: boolean;
  switching?: boolean;
  error?: string | null;
  onChange?(mode: FilePermissionMode): void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef(false);
  const unavailable = disabled || switching || onChange === undefined;
  const close = (restoreFocus = true) => {
    restoreFocusRef.current = restoreFocus;
    setOpen(false);
  };
  useEffect(() => {
    if (unavailable) setOpen(false);
  }, [unavailable]);
  useEffect(() => {
    if (!open) return;
    (
      menuRef.current?.querySelector<HTMLButtonElement>(
        '[aria-checked="true"]',
      ) ?? menuRef.current?.querySelector<HTMLButtonElement>("button")
    )?.focus();
  }, [open]);
  useLayoutEffect(() => {
    if (open || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    triggerRef.current?.focus();
  }, [open]);
  return (
    <Popover open={open && !unavailable} onOpenChange={setOpen}>
      <div className="permission-picker" ref={containerRef}>
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            className="composer-model-trigger permission-trigger"
            type="button"
            aria-label="File permissions"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-describedby={error ? "composer-permission-error" : undefined}
            disabled={unavailable}
            title={
              disabled
                ? "Wait for the current operation to finish before changing permissions"
                : "File permissions for this thread"
            }
            onClick={() => (open ? close() : setOpen(true))}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
              event.preventDefault();
              setOpen(true);
            }}
          >
            <span role={switching ? "status" : undefined}>
              {switching
                ? "Saving…"
                : legacyApproval
                  ? "Approval required"
                  : permissionLabels[value]}
            </span>
            <Icon name="chevron-down" size={12} />
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="composer-selection-menu permission-menu"
          ref={menuRef}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (
              menuRef.current?.querySelector<HTMLButtonElement>(
                '[aria-checked="true"]',
              ) ?? menuRef.current?.querySelector<HTMLButtonElement>("button")
            )?.focus();
          }}
          onCloseAutoFocus={(event) => event.preventDefault()}
          role="menu"
          aria-label="File permissions"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
              return;
            }
            if (event.key === "Tab") {
              triggerRef.current?.focus();
              close(false);
              return;
            }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
            );
            const current = items.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : (current +
                      (event.key === "ArrowUp" ? -1 : 1) +
                      items.length) %
                    items.length;
            items[next]?.focus();
          }}
        >
          {Object.entries(permissionLabels).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              role="menuitemradio"
              data-permission={mode}
              aria-checked={!legacyApproval && mode === value}
              onClick={() => {
                onChange?.(mode as FilePermissionMode);
                close();
              }}
            >
              <span>
                <strong>{label}</strong>
                <small>
                  {permissionDescriptions[mode as FilePermissionMode]}
                </small>
              </span>
              {!legacyApproval && mode === value ? (
                <Icon name="check" size={13} />
              ) : null}
            </button>
          ))}
          {legacyApproval || value !== "danger-full-access" ? (
            <p className="composer-menu-note">
              Actions outside these limits require approval.
            </p>
          ) : null}
        </PopoverContent>
        {error ? (
          <span
            id="composer-permission-error"
            role="alert"
            className="permission-error"
          >
            {error}
          </span>
        ) : null}
      </div>
    </Popover>
  );
}
