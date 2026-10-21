import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/** A presentation-only icon/text sweep. The caller owns actual activity. */
export function ActivityText({
  children,
  active,
  className = "",
  leading,
  prefix,
  preview = false,
}: {
  children: string;
  active: boolean;
  className?: string;
  leading?: ReactNode;
  prefix?: string;
  preview?: boolean;
}) {
  const element = useRef<HTMLSpanElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [visible, setVisible] = useState(false);
  const [onScreen, setOnScreen] = useState(false);

  useEffect(() => {
    const updateVisibility = () =>
      setVisible(document.visibilityState !== "hidden");
    updateVisibility();
    document.addEventListener("visibilitychange", updateVisibility);
    const target = element.current;
    const observer =
      target && typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(([entry]) => {
            setOnScreen(entry?.isIntersecting === true);
          })
        : null;
    if (target && observer) observer.observe(target);
    else setOnScreen(true);

    return () => {
      document.removeEventListener("visibilitychange", updateVisibility);
      observer?.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    const target = label.current;
    if (!target || !preview) {
      setOverflowing(false);
      return;
    }
    const measure = () =>
      setOverflowing(target.scrollWidth > target.clientWidth + 1);
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(target);
    return () => observer?.disconnect();
  }, [children, prefix, preview]);

  return (
    <span
      ref={element}
      className={`activity-text ${className}`.trim()}
      data-preview={preview || undefined}
      data-overflow={overflowing || undefined}
      data-active={active}
      data-animating={active && visible && onScreen}
    >
      <span className="activity-content">
        {leading}
        {prefix ? <strong>{prefix}</strong> : null}
        {prefix && children ? " " : null}
        <span ref={label} className="activity-label">
          {children}
        </span>
      </span>
      {active ? (
        <span className="activity-sweep" aria-hidden="true" inert>
          <span className="activity-sweep-counter">
            <span className="activity-sweep-aligned">
              <span className="activity-content">
                {leading}
                {prefix ? <strong data-activity-copy={prefix} /> : null}
                <span
                  className="activity-label"
                  data-activity-copy={children}
                />
              </span>
            </span>
          </span>
        </span>
      ) : null}
    </span>
  );
}
