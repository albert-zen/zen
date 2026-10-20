import { useEffect, useRef, useState, type ReactNode } from "react";

/** A presentation-only icon/text sweep. The caller owns actual activity. */
export function ActivityText({
  children,
  active,
  className = "",
  leading,
  prefix,
}: {
  children: string;
  active: boolean;
  className?: string;
  leading?: ReactNode;
  prefix?: string;
}) {
  const element = useRef<HTMLSpanElement>(null);
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

  return (
    <span
      ref={element}
      className={`activity-text ${className}`.trim()}
      data-active={active}
      data-animating={active && visible && onScreen}
    >
      <span className="activity-content">
        {leading}
        {prefix ? <strong>{prefix}</strong> : null}
        <span className="activity-label">{children}</span>
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
