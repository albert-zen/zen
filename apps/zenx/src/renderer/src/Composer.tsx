import {
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type RefObject,
} from "react";
import type { ComposerInput } from "./composer-input.js";
import { Icon } from "./icons.js";

/** Shared presentation only. Drafts, admission and permissions remain with callers. */
export function ComposerShell({
  className = "",
  ...props
}: ComponentProps<"form">) {
  return <form {...props} className={`composer ${className}`.trim()} />;
}

// Empty editors have a native rows/min-height baseline. Let CSS establish
// it instead of forcing the entire conversation through an auto-height read.
// Nonempty text still uses the existing bounded scroll-height measurement.
function resizeComposerEditor(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";
  if (textarea.value.length === 0) {
    textarea.style.overflowY = "hidden";
    return;
  }
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
}

export function ComposerEditor({
  textareaRef,
  ...props
}: ComponentProps<"textarea"> & {
  textareaRef?: RefObject<ComposerInput | null>;
}) {
  const localRef = useRef<HTMLTextAreaElement>(null);
  const ref = (textareaRef ??
    localRef) as RefObject<HTMLTextAreaElement | null>;
  useLayoutEffect(() => {
    const textarea = ref.current;
    if (textarea !== null) resizeComposerEditor(textarea);
  }, [props.value, props.rows, ref]);
  useLayoutEffect(() => {
    const textarea = ref.current;
    if (textarea === null) return;
    const onResize = () => resizeComposerEditor(textarea);
    window.addEventListener("resize", onResize);
    let width: number | undefined;
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entries) => {
            const next = entries.find((entry) => entry.target === textarea)
              ?.contentRect.width;
            if (next === undefined || next === width) return;
            width = next;
            // Observer entries supply geometry without a second synchronous
            // getBoundingClientRect read. Always use the live committed value.
            resizeComposerEditor(textarea);
          });
    observer?.observe(textarea);
    return () => {
      window.removeEventListener("resize", onResize);
      observer?.disconnect();
    };
  }, [ref]);
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
