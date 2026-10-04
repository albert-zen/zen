import {
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type RefObject,
} from "react";
import { Icon } from "./icons.js";

/** Shared presentation only. Drafts, admission and permissions remain with callers. */
export function ComposerShell({
  className = "",
  ...props
}: ComponentProps<"form">) {
  return <form {...props} className={`composer ${className}`.trim()} />;
}

export function ComposerEditor({
  textareaRef,
  ...props
}: ComponentProps<"textarea"> & {
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const localRef = useRef<HTMLTextAreaElement>(null);
  const ref = textareaRef ?? localRef;
  useLayoutEffect(() => {
    const textarea = ref.current;
    if (textarea === null) return;
    const resize = () => {
      textarea.style.height = "auto";
      const contentHeight = textarea.scrollHeight;
      const style = window.getComputedStyle(textarea);
      const declaredMinHeight = Number.parseFloat(style.minHeight);
      const minHeight = Number.isFinite(declaredMinHeight)
        ? declaredMinHeight
        : 36;
      const declaredMaxHeight = Number.parseFloat(style.maxHeight);
      const maxHeight = Number.isFinite(declaredMaxHeight)
        ? declaredMaxHeight
        : 136;
      const height = Math.min(Math.max(contentHeight, minHeight), maxHeight);
      textarea.style.height = `${height}px`;
      textarea.style.overflowY = contentHeight > height ? "auto" : "hidden";
    };
    resize();
    window.addEventListener("resize", resize);
    let width = textarea.getBoundingClientRect().width;
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            const next = textarea.getBoundingClientRect().width;
            if (next === width) return;
            width = next;
            resize();
          });
    observer?.observe(textarea);
    return () => {
      window.removeEventListener("resize", resize);
      observer?.disconnect();
    };
  }, [props.value, ref]);
  return (
    <textarea
      {...props}
      ref={ref}
      data-autogrow="true"
      rows={props.rows ?? 1}
    />
  );
}

export function ComposerAction({
  mode = "send",
  label,
  className = "",
  ...props
}: ComponentProps<"button"> & { mode?: string; label: string }) {
  return (
    <button
      {...props}
      className={`action-orb ${mode} ${className}`.trim()}
      type="button"
      aria-label={label}
    >
      <Icon name={mode === "stop" ? "stop" : "send"} size={18} />
    </button>
  );
}
