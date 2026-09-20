import { useEffect, useState } from "react";

const names = [
  "--color-surface-main",
  "--color-surface-control",
  "--color-surface-control-hover",
  "--color-text-primary",
  "--color-text-secondary",
  "--color-border-control",
  "--color-focus-ring",
  "--color-accent",
  "--font-size-body",
  "--font-size-label",
  "--control-height",
  "--radius-control",
] as const;
export interface PluginThemeV1 {
  readonly version: 1;
  readonly variables: Readonly<Record<string, string>>;
  readonly reducedMotion: boolean;
}
function readTheme(): PluginThemeV1 {
  const style = window.getComputedStyle(document.documentElement);
  return Object.freeze({
    version: 1,
    variables: Object.freeze(
      Object.fromEntries(
        names.map((name) => [name, style.getPropertyValue(name).trim()]),
      ),
    ),
    reducedMotion:
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  });
}
export function usePluginTheme(): PluginThemeV1 {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    const update = () =>
      setTheme((previous) => {
        const next = readTheme();
        return JSON.stringify(previous) === JSON.stringify(next)
          ? previous
          : next;
      });
    const observer = new window.MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true });
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    motion?.addEventListener("change", update);
    update();
    return () => {
      observer.disconnect();
      motion?.removeEventListener("change", update);
    };
  }, []);
  return theme;
}

export const pluginBaseStyles = `
body { margin: 0; padding: 16px; font: var(--font-size-body,14px)/1.55 "Segoe UI",sans-serif; background: var(--color-surface-main); color: var(--color-text-primary); }
* { box-sizing: border-box; }
button,input,textarea,select { font: inherit; color: inherit; min-height: var(--control-height,32px); padding: 6px 10px; border: 1px solid var(--color-border-control); border-radius: var(--radius-control,7px); background: var(--color-surface-control); }
button,summary { cursor:pointer; } button:hover { background:var(--color-surface-control-hover); } button:disabled { opacity:.5; cursor:not-allowed; }
label { display:grid; gap:6px; } :focus-visible { outline:2px solid var(--color-focus-ring); outline-offset:3px; }
input { accent-color:var(--color-accent); } small { color:var(--color-text-secondary); } textarea { max-width:100%; }
@media(prefers-reduced-motion:reduce) { *,*::before,*::after { animation-duration:.01ms!important; transition-duration:.01ms!important; scroll-behavior:auto!important; } }
`;
