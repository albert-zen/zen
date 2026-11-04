/** Presentation-only experiment. The owning main process supplies tab identities. */
export class PersistentGuestHost {
  #guests = new Map();
  constructor(container, createElement = (tag) => document.createElement(tag)) {
    this.container = container;
    this.createElement = createElement;
  }
  add(id, url, partition) {
    if (this.#guests.has(id)) throw new Error(`Duplicate guest: ${id}`);
    const guest = this.createElement("webview");
    guest.setAttribute("partition", partition);
    guest.setAttribute("src", url);
    guest.setAttribute(
      "webpreferences",
      "contextIsolation=yes,sandbox=yes,nodeIntegration=no,backgroundThrottling=no",
    );
    guest.dataset.tabId = id;
    guest.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;visibility:hidden;pointer-events:none";
    this.container.append(guest);
    this.#guests.set(id, guest);
    return guest;
  }
  show(id) {
    if (id !== undefined && !this.#guests.has(id))
      throw new Error(`Unknown guest: ${id}`);
    for (const [key, guest] of this.#guests) {
      guest.style.visibility = key === id ? "visible" : "hidden";
      guest.style.pointerEvents = key === id ? "auto" : "none";
    }
  }
  close(id) {
    const guest = this.#guests.get(id);
    if (!guest) throw new Error(`Unknown guest: ${id}`);
    guest.remove();
    this.#guests.delete(id);
  }
}
