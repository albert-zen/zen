import React, { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./icons.js";

/** Disposable visual hint, mounted only in the workspace split overlay. */
export function InformationOverflowCue({ label }: { label: string }) {
  const marker = useRef<HTMLSpanElement>(null);
  const [moreBelow, setMoreBelow] = useState(false);
  useLayoutEffect(() => {
    const content = marker.current
      ?.closest(".information-popover")
      ?.querySelector<HTMLElement>(":scope > .information-content");
    if (!content) return;
    const measure = () => {
      // Ignore subpixel rounding and hidden/unfinished layout. Never move the
      // reader, synthesize a scrollbar, or infer overflow from provider data.
      setMoreBelow(
        content.clientHeight > 0 &&
          content.scrollHeight - content.clientHeight - content.scrollTop > 1,
      );
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    const bindContent = () => {
      observer?.disconnect();
      observer?.observe(content);
      // Direct provider roots grow/shrink with their descendants. No transcript
      // observation or per-control listener is needed.
      for (const child of content.children) observer?.observe(child);
      measure();
    };
    const children =
      typeof MutationObserver === "undefined"
        ? undefined
        : new MutationObserver(bindContent);
    children?.observe(content, { childList: true });
    content.addEventListener("scroll", measure, { passive: true });
    bindContent();
    return () => {
      content.removeEventListener("scroll", measure);
      observer?.disconnect();
      children?.disconnect();
    };
  }, []);
  return (
    <span
      ref={marker}
      className="information-overflow-cue"
      hidden={!moreBelow}
      aria-hidden="true"
    >
      <Icon name="chevron-down" size={12} />
      <span>{label}</span>
    </span>
  );
}
