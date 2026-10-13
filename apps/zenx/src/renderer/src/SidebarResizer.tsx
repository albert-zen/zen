import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  clampSidebarWidth,
  readSidebarWidth,
  sidebarWidthLimit,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_OVERLAY_BREAKPOINT,
  SIDEBAR_WIDTH_KEY,
} from "./sidebar-width.js";

interface ResizeGesture {
  pointerId: number;
  element: HTMLDivElement;
  startX: number;
  startWidth: number;
  originalPreference: number;
  width: number;
  changed: boolean;
}

/** Isolated from App rendering: pointer movement only changes layout and this control. */
export function SidebarResizer({
  collapsed,
  onCollapse,
}: {
  collapsed: boolean;
  onCollapse(): void;
}) {
  const { t } = useTranslation("shell");
  const separator = useRef<HTMLDivElement>(null);
  const gesture = useRef<ResizeGesture | null>(null);
  const [preferredWidth, setPreferredWidth] = useState(() => {
    try {
      return readSidebarWidth(window.localStorage);
    } catch {
      return SIDEBAR_DEFAULT_WIDTH;
    }
  });
  const [containerWidth, setContainerWidth] = useState(() => window.innerWidth);
  const [resizing, setResizing] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const width = clampSidebarWidth(preferredWidth, containerWidth);
  const enabled = !collapsed && containerWidth > SIDEBAR_OVERLAY_BREAKPOINT;

  const save = useCallback((value: number) => {
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(value));
      setSaveFailed(false);
    } catch {
      setSaveFailed(true);
    }
  }, []);
  const finish = useCallback(
    (commit: boolean) => {
      const active = gesture.current;
      if (!active) return;
      // Clear before releasing: lostpointercapture may fire synchronously.
      gesture.current = null;
      setResizing(false);
      if (active.element.hasPointerCapture(active.pointerId))
        active.element.releasePointerCapture(active.pointerId);
      if (commit && active.changed) save(active.width);
      else setPreferredWidth(active.originalPreference);
    },
    [save],
  );

  useLayoutEffect(() => {
    const shell = separator.current?.parentElement;
    if (!shell) return;
    let previousWidth = shell.getBoundingClientRect().width;
    const measure = () => {
      const next = shell.getBoundingClientRect().width;
      if (next !== previousWidth) finish(false);
      previousWidth = next;
      setContainerWidth(next);
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(shell);
    const cancel = () => finish(false);
    const visibility = () => {
      if (document.visibilityState === "hidden") cancel();
    };
    const sync = (event: StorageEvent) => {
      if (event.key !== SIDEBAR_WIDTH_KEY && event.key !== null) return;
      // A newer window preference supersedes an unfinished local gesture.
      cancel();
      try {
        setPreferredWidth(readSidebarWidth(window.localStorage));
      } catch {
        setPreferredWidth(SIDEBAR_DEFAULT_WIDTH);
      }
      setSaveFailed(false);
    };
    window.addEventListener("resize", measure);
    window.addEventListener("blur", cancel);
    window.addEventListener("storage", sync);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("storage", sync);
      document.removeEventListener("visibilitychange", visibility);
      cancel();
      shell.style.removeProperty("--sidebar-width");
    };
  }, [finish]);

  useLayoutEffect(() => {
    separator.current?.parentElement?.style.setProperty(
      "--sidebar-width",
      `${width}px`,
    );
  }, [width]);
  useLayoutEffect(() => {
    if (!enabled) {
      finish(false);
      if (document.activeElement === separator.current)
        document
          .querySelector<HTMLButtonElement>(
            containerWidth <= SIDEBAR_OVERLAY_BREAKPOINT
              ? ".mobile-menu"
              : ".sidebar-collapse-button",
          )
          ?.focus();
    }
  }, [enabled, containerWidth, finish]);

  return (
    <>
      <div
        ref={separator}
        className="sidebar-resizer"
        role="separator"
        aria-label={t("sidebarWidth")}
        aria-controls="primary-sidebar"
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={sidebarWidthLimit(containerWidth)}
        aria-valuenow={width}
        aria-valuetext={t("sidebarWidthPixels", { width })}
        aria-hidden={!enabled || undefined}
        tabIndex={enabled ? 0 : -1}
        data-resizing={resizing}
        title={t("sidebarResizeHelp")}
        onPointerDown={(event) => {
          if (
            !enabled ||
            event.button !== 0 ||
            !event.isPrimary ||
            gesture.current
          )
            return;
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            return;
          }
          event.preventDefault();
          event.currentTarget.focus();
          gesture.current = {
            pointerId: event.pointerId,
            element: event.currentTarget,
            startX: event.clientX,
            startWidth: width,
            originalPreference: preferredWidth,
            width,
            changed: false,
          };
          setResizing(true);
        }}
        onPointerMove={(event) => {
          const active = gesture.current;
          if (!active || active.pointerId !== event.pointerId) return;
          const next = clampSidebarWidth(
            active.startWidth + event.clientX - active.startX,
            containerWidth,
          );
          active.width = next;
          active.changed = next !== active.startWidth;
          setPreferredWidth(next);
        }}
        onPointerUp={(event) => {
          if (gesture.current?.pointerId === event.pointerId) finish(true);
        }}
        onPointerCancel={(event) => {
          if (gesture.current?.pointerId === event.pointerId) finish(false);
        }}
        onLostPointerCapture={(event) => {
          if (gesture.current?.pointerId === event.pointerId) finish(false);
        }}
        onKeyDown={(event) => {
          if (!enabled || event.altKey || event.ctrlKey || event.metaKey)
            return;
          if (event.key === "Escape" && gesture.current) {
            event.preventDefault();
            finish(false);
            return;
          }
          if (gesture.current) return;
          if (event.key === "Enter") {
            event.preventDefault();
            onCollapse();
            document
              .querySelector<HTMLButtonElement>(".sidebar-collapse-button")
              ?.focus();
            return;
          }
          const step = event.shiftKey ? 50 : 10;
          const next =
            event.key === "ArrowLeft"
              ? width - step
              : event.key === "ArrowRight"
                ? width + step
                : event.key === "Home"
                  ? SIDEBAR_MIN_WIDTH
                  : event.key === "End"
                    ? sidebarWidthLimit(containerWidth)
                    : null;
          if (next === null) return;
          event.preventDefault();
          const value = clampSidebarWidth(next, containerWidth);
          if (value !== width || saveFailed) {
            setPreferredWidth(value);
            save(value);
          }
        }}
      />
      {saveFailed && enabled ? (
        <div className="sidebar-resize-notice" role="status">
          {t("sidebarWidthSaveFailed")}
        </div>
      ) : null}
    </>
  );
}
