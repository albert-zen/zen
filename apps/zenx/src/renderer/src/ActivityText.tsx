import { useEffect, useRef, useState } from "react";

/** A text-only activity cue. The caller owns whether work is actually running. */
export function ActivityText({
  children,
  active,
  className = "",
}: {
  children: string;
  active: boolean;
  className?: string;
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
      {children}
    </span>
  );
}
