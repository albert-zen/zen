/** Reveal native scrollbars on activity without changing geometry or scrolling. */
export function installScrollbarVisibility(document: Document): () => void {
  const view = document.defaultView;
  if (!view) return () => {};
  const timers = new Map<Element, ReturnType<typeof setTimeout>>();
  let edge: Element | undefined;
  let dragging: Element | undefined;
  const reveal = (element: Element) => {
    clearTimeout(timers.get(element));
    element.setAttribute("data-scrollbar-active", "");
    timers.set(
      element,
      setTimeout(() => {
        timers.delete(element);
        if (element !== edge && element !== dragging) {
          element.removeAttribute("data-scrollbar-active");
        }
      }, 1000),
    );
  };
  const axes = (element: Element) => {
    const style = view.getComputedStyle(element);
    const root = element === document.scrollingElement;
    return {
      vertical:
        (/auto|scroll/.test(style.overflowY) ||
          (root && style.overflowY === "visible")) &&
        element.scrollHeight > element.clientHeight,
      horizontal:
        (/auto|scroll/.test(style.overflowX) ||
          (root && style.overflowX === "visible")) &&
        element.scrollWidth > element.clientWidth,
    };
  };
  const ancestors = (target: EventTarget | null) => {
    const result: Element[] = [];
    for (
      let element = target instanceof view.Element ? target : null;
      element;
      element = element.parentElement
    ) {
      const { vertical, horizontal } = axes(element);
      if (vertical || horizontal) result.push(element);
    }
    return result;
  };
  const onScroll = (event: Event) => {
    const target =
      event.target === document ? document.scrollingElement : event.target;
    if (target instanceof view.Element) reveal(target);
  };
  const onFocus = (event: Event) => ancestors(event.target).forEach(reveal);
  const onKey = (event: KeyboardEvent) => {
    if (
      [
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "PageUp",
        "PageDown",
        "Home",
        "End",
        " ",
        "Tab",
      ].includes(event.key)
    )
      onFocus(event);
  };
  const updateEdge = (event: PointerEvent, target: EventTarget | null) => {
    const next = ancestors(target).find((element) => {
      const rect = element.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      )
        return false;
      const style = view.getComputedStyle(element);
      const { vertical, horizontal } = axes(element);
      return (
        (vertical &&
          (style.direction === "rtl"
            ? event.clientX <= rect.left + 14
            : event.clientX >= rect.right - 14)) ||
        (horizontal && event.clientY >= rect.bottom - 14)
      );
    });
    const previous = edge;
    edge = next;
    if (previous && previous !== next) reveal(previous);
    if (next) reveal(next);
  };
  const onMove = (event: PointerEvent) => updateEdge(event, event.target);
  const onDown = (event: PointerEvent) => {
    onMove(event);
    dragging = edge;
  };
  const endDrag = () => {
    const previous = dragging;
    dragging = undefined;
    if (previous) reveal(previous);
  };
  const onUp = (event: PointerEvent) => {
    // Native scrollbar drags can consume all pointermoves, and their release
    // target can still be the original scroller. Reconcile actual release hit
    // position before expiry so stale edge state cannot keep the thumb painted.
    updateEdge(
      event,
      document.elementFromPoint
        ? document.elementFromPoint(event.clientX, event.clientY)
        : event.target,
    );
    endDrag();
  };
  const onLeave = () => {
    const previous = edge;
    edge = undefined;
    if (previous) reveal(previous);
  };
  const onCancel = () => {
    onLeave();
    endDrag();
  };
  document.documentElement.setAttribute("data-scrollbar-autohide", "");
  document.addEventListener("scroll", onScroll, true);
  document.addEventListener("focusin", onFocus);
  document.addEventListener("keydown", onKey);
  document.addEventListener("pointermove", onMove, { passive: true });
  document.addEventListener("pointerdown", onDown, { passive: true });
  document.addEventListener("pointerup", onUp, true);
  document.addEventListener("pointercancel", onCancel, true);
  document.documentElement.addEventListener("pointerleave", onLeave);
  view.addEventListener("blur", onCancel);
  return () => {
    document.documentElement.removeAttribute("data-scrollbar-autohide");
    document.removeEventListener("scroll", onScroll, true);
    document.removeEventListener("focusin", onFocus);
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerdown", onDown);
    document.removeEventListener("pointerup", onUp, true);
    document.removeEventListener("pointercancel", onCancel, true);
    document.documentElement.removeEventListener("pointerleave", onLeave);
    view.removeEventListener("blur", onCancel);
    for (const timer of timers.values()) clearTimeout(timer);
    document
      .querySelectorAll("[data-scrollbar-active]")
      .forEach((element) => element.removeAttribute("data-scrollbar-active"));
  };
}
