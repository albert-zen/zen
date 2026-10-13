/** One transient viewport/focus snapshot, owned by the removal interaction. */
export interface SidebarRemovalSnapshot {
  row: HTMLElement;
  scroller: HTMLElement;
  focus: Element | null;
  scrollTop: number;
  neighbors: HTMLElement[];
  anchors: { row: HTMLElement; top: number }[];
  disclosureOwners: HTMLElement[];
}

export function captureSidebarRemoval(
  row: HTMLElement,
): SidebarRemovalSnapshot | null {
  const scroller = row.closest<HTMLElement>(".sidebar-scroll");
  if (scroller === null || row.closest("[inert], [hidden]")) return null;
  const disclosureOwners: HTMLElement[] = [];
  for (
    let owner = row.parentElement;
    owner !== null;
    owner = owner.parentElement
  ) {
    disclosureOwners.push(owner);
    if (owner === scroller) break;
  }
  const rows = [
    ...scroller.querySelectorAll<HTMLElement>(".thread-row-shell"),
  ].filter((entry) => !entry.closest("[inert], [hidden]"));
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
    disclosureOwners,
    anchors: [
      ...visible,
      ...neighbors.filter((entry) => !visible.includes(entry)),
    ].map((entry) => ({ row: entry, top: entry.getBoundingClientRect().top })),
  };
}

export function restoreSidebarRemoval(snapshot: SidebarRemovalSnapshot): void {
  const { scroller, focus, neighbors, anchors } = snapshot;
  if (
    !scroller.isConnected ||
    snapshot.disclosureOwners.some((owner) =>
      owner.matches("[inert], [hidden]"),
    )
  )
    return;
  const available = (row: HTMLElement) =>
    row.isConnected && !row.closest("[inert], [hidden]");
  const anchor = anchors.find((entry) => available(entry.row));
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
  const neighbor = neighbors.find(available);
  // The menu trigger is visibility:hidden until its row has focus/hover.
  // Reveal it through the visible row first; both focus moves must avoid scroll.
  neighbor
    ?.querySelector<HTMLElement>(".thread-row")
    ?.focus({ preventScroll: true });
  const target =
    neighbor?.querySelector<HTMLElement>(".thread-menu-trigger") ??
    document.getElementById("sidebar-thread-list-heading");
  target?.focus({ preventScroll: true });
}
