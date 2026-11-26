import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./icons.js";

/** Only projects the owning AuxiliaryPanel's current retained tabs. */
export function CollapsedWorkspaceTabsPreview({
  tabs,
  ownerId,
  activate,
  label,
}: {
  tabs: readonly { id: string; title: string; icon: IconName }[];
  ownerId: string;
  activate(id: string): void;
  label: string;
}) {
  const id = useId();
  const popup = useRef<HTMLDivElement>(null);
  const latest = useRef({ tabs, activate });
  latest.current = { tabs, activate };
  const trigger = useRef<HTMLButtonElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressFocus = useRef(false);
  const focusFirst = useRef(false);
  const [position, setPosition] = useState<{
    top: number;
    right: number;
  } | null>(null);
  const cancelTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const close = () => {
    cancelTimer();
    focusFirst.current = false;
    setPosition(null);
  };
  const leave = () => {
    cancelTimer();
    timer.current = setTimeout(() => {
      timer.current = null;
      if (
        !popup.current?.contains(document.activeElement) &&
        document.activeElement !== trigger.current
      )
        setPosition(null);
    }, 180);
  };
  useEffect(() => {
    const button = document.getElementById(
      "thread-browser-toggle",
    ) as HTMLButtonElement | null;
    if (
      !button ||
      button.disabled ||
      button.dataset.workspaceOwner !== ownerId ||
      tabs.length === 0
    )
      return;
    trigger.current = button;
    const show = () => {
      cancelTimer();
      if (
        !button.isConnected ||
        button.disabled ||
        button.dataset.workspaceOwner !== ownerId ||
        latest.current.tabs.length === 0
      )
        return;
      const rect = button.getBoundingClientRect();
      setPosition({
        top: rect.bottom + 6,
        right: Math.max(8, window.innerWidth - rect.right),
      });
    };
    const enter = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      cancelTimer();
      timer.current = setTimeout(show, 200);
    };
    const focus = () => {
      if (!suppressFocus.current) show();
    };
    const key = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.metaKey ||
        event.ctrlKey
      )
        return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        focusFirst.current = true;
        show();
      } else if (event.key === "Escape") close();
    };
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !button.contains(event.target) &&
        !popup.current?.contains(event.target)
      )
        close();
    };
    button.addEventListener("pointerenter", enter);
    button.addEventListener("pointerleave", leave);
    button.addEventListener("focus", focus);
    button.addEventListener("blur", leave);
    button.addEventListener("keydown", key);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      cancelTimer();
      button.removeEventListener("pointerenter", enter);
      button.removeEventListener("pointerleave", leave);
      button.removeEventListener("focus", focus);
      button.removeEventListener("blur", leave);
      button.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      trigger.current = null;
    };
  }, [id, ownerId, tabs.length > 0]);
  useEffect(() => {
    if (position && focusFirst.current) {
      focusFirst.current = false;
      popup.current?.querySelector<HTMLButtonElement>("button")?.focus();
    }
  }, [position]);
  if (!position || tabs.length === 0) return null;
  return createPortal(
    <div
      ref={popup}
      className="collapsed-workspace-tabs-preview"
      style={position}
      role="region"
      aria-labelledby={id}
      onPointerEnter={cancelTimer}
      onPointerLeave={leave}
      onFocus={cancelTimer}
      onBlur={leave}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.defaultPrevented) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
          suppressFocus.current = true;
          trigger.current?.focus();
          suppressFocus.current = false;
          return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
          return;
        const buttons = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
        ];
        const index = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (index +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  buttons.length) %
                buttons.length;
        event.preventDefault();
        buttons[next]?.focus();
      }}
    >
      <div className="collapsed-workspace-tabs-heading" id={id}>
        {label}
      </div>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => {
            // A late click may never restore a tab removed from the current owner.
            if (
              trigger.current?.dataset.workspaceOwner !== ownerId ||
              !latest.current.tabs.some((item) => item.id === tab.id)
            )
              return;
            close();
            latest.current.activate(tab.id);
          }}
        >
          <Icon name={tab.icon} />
          <span>{tab.title}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
