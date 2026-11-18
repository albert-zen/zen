/** The internally fullscreen workspace owns this chord, never a global shortcut.
 * Query its actual tab rail at dispatch time so reorder/close cannot leave stale
 * indices. Clicking the tab reuses the primary/resource selection boundary. */
export function installWorkspaceTabShortcuts(
  rail: HTMLElement,
  platform: "darwin" | "win32" = "darwin",
): () => void {
  const doc = rail.ownerDocument;
  const win = doc.defaultView!;
  let held = false;
  const chordHeld = (event: KeyboardEvent) =>
    event.altKey &&
    !event.shiftKey &&
    !event.getModifierState("AltGraph") &&
    (platform === "darwin"
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey);
  const tabs = () =>
    Array.from(
      rail.querySelectorAll<HTMLButtonElement>(
        '.workspace-content-tab > button[role="tab"]',
      ),
    ).filter((tab) => !tab.disabled && !tab.closest("[inert]"));
  const blocked = (target: EventTarget | null) =>
    Boolean(
      doc.querySelector(
        '[role="dialog"]:not(.thread-information), dialog[open], [aria-modal="true"], [role="menu"]',
      ),
    ) ||
    (target instanceof win.Element &&
      Boolean(
        target.closest(
          ".project-menu, .thread-menu-rename, [data-keybinding-capture]",
        ),
      ));
  const clear = () => {
    held = false;
    observer.disconnect();
    rail.querySelectorAll("[data-workspace-shortcut-key]").forEach((tab) => {
      tab.removeAttribute("data-workspace-shortcut-key");
      tab.removeAttribute("data-workspace-shortcut-label");
    });
  };
  const project = () => {
    rail.querySelectorAll("[data-workspace-shortcut-key]").forEach((tab) => {
      tab.removeAttribute("data-workspace-shortcut-key");
      tab.removeAttribute("data-workspace-shortcut-label");
    });
    if (!held || blocked(doc.activeElement)) return;
    tabs()
      .slice(0, 9)
      .forEach((tab, index) => {
        tab.setAttribute("data-workspace-shortcut-key", String(index + 1));
        tab.setAttribute(
          "data-workspace-shortcut-label",
          `${platform === "darwin" ? "⌘⌥" : "Ctrl+Alt+"}${index + 1}`,
        );
      });
  };
  const keydown = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.keyCode === 229 ||
      !chordHeld(event) ||
      blocked(event.target)
    ) {
      clear();
      return;
    }
    if (!held) {
      observer.observe(rail, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["inert", "disabled"],
      });
      observer.observe(doc.body, { childList: true, subtree: true });
    }
    held = true;
    project();
    if (event.repeat) return;
    // Option produces locale-dependent symbols in `key`, e.g. ¡ rather than 1.
    const digit = /^Digit([1-9])$/u.exec(event.code);
    if (!digit) return;
    const target = tabs()[Number(digit[1]) - 1];
    if (!target) return;
    event.preventDefault();
    target.click();
    target.focus({ preventScroll: true });
  };
  const keyup = (event: KeyboardEvent) => {
    if (!chordHeld(event)) clear();
  };
  const focus = () => {
    if (blocked(doc.activeElement)) clear();
  };
  const observer = new win.MutationObserver(() => {
    if (held) project();
  });
  win.addEventListener("keydown", keydown);
  win.addEventListener("keyup", keyup);
  win.addEventListener("blur", clear);
  doc.addEventListener("focusin", focus);
  doc.addEventListener("compositionstart", clear);
  return () => {
    observer.disconnect();
    clear();
    win.removeEventListener("keydown", keydown);
    win.removeEventListener("keyup", keyup);
    win.removeEventListener("blur", clear);
    doc.removeEventListener("focusin", focus);
    doc.removeEventListener("compositionstart", clear);
  };
}
