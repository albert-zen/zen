import { useEffect, useState } from "react";

/** Each disclosure owns a key, so changing one never overwrites another. */
export function useSidebarExpansion(identity: string) {
  const key = `zenx.sidebar.expanded.${encodeURIComponent(identity)}`;
  const read = () => {
    try {
      return window.localStorage.getItem(key) !== "false";
    } catch {
      return true;
    }
  };
  const [expanded, setExpanded] = useState(read);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === key || event.key === null) setExpanded(read());
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [key]);
  const toggle = () => {
    const next = !expanded;
    try {
      window.localStorage.setItem(key, String(next));
      setError(null);
    } catch {
      setError("Could not save sidebar expansion. Try toggling again.");
    }
    setExpanded(next);
  };
  return [expanded, toggle, error] as const;
}
