/** One transient viewport/focus snapshot, owned by the removal interaction. */
export interface SidebarRemovalSnapshot {
  row: HTMLElement;
  scroller: HTMLElement;
  focus: Element | null;
  scrollTop: number;
  neighbors: HTMLElement[];
  anchors: { row: HTMLElement; top: number }[];
}

export function captureSidebarRemoval(
  row: HTMLElement,
): SidebarRemovalSnapshot | null {
  const scroller = row.closest<HTMLElement>(".sidebar-scroll");
  if (scroller === null) return null;
  const rows = [...scroller.querySelectorAll<HTMLElement>(".thread-row-shell")];
  const index = rows.indexOf(row);
  const neighbors = [
    ...rows.slice(index + 1),
    ...rows.slice(0, index).reverse(),
  ];
  const viewport = scroller.getBoundingClientRect();
  const visible = neighbors.filter((entry) => {
    const bounds = entry.getBoundingClientRect();
    return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
  });
  return {
    row,
    scroller,
    focus: document.activeElement,
    scrollTop: scroller.scrollTop,
    neighbors,
    anchors: [
      ...visible,
      ...neighbors.filter((entry) => !visible.includes(entry)),
    ].map((entry) => ({ row: entry, top: entry.getBoundingClientRect().top })),
  };
}

export function restoreSidebarRemoval(snapshot: SidebarRemovalSnapshot): void {
  const { scroller, focus, neighbors, anchors } = snapshot;
  if (!scroller.isConnected) return;
  const anchor = anchors.find((entry) => entry.row.isConnected);
  if (anchor !== undefined) {
    // Assign instantly; native scroll anchoring may already have applied this delta.
    // Browsers clamp at the list end. No animation, including in reduced-motion mode.
    scroller.scrollTop += anchor.row.getBoundingClientRect().top - anchor.top;
  } else {
    scroller.scrollTop = snapshot.scrollTop;
  }
  const current = document.activeElement;
  if (
    current !== focus &&
    !(current === document.body && focus?.isConnected === false)
  )
    return;
  const neighbor = neighbors.find((entry) => entry.isConnected);
  const target =
    neighbor?.querySelector<HTMLElement>(".thread-menu-trigger") ??
    document.getElementById("sidebar-thread-list-heading");
  target?.focus({ preventScroll: true });
}
