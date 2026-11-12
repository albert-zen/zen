import { AsyncLocalStorage } from "node:async_hooks";

// Disposable Host presentation ordering only; never dispatch or retry authority.
const activeOrder = new AsyncLocalStorage<number>();
let lastOrder = 0;

export function browserOperationOrder(): number {
  return activeOrder.getStore() ?? ++lastOrder;
}

export function withBrowserOperationOrder<T>(run: () => T, inherit = false): T {
  if (inherit && activeOrder.getStore() !== undefined) return run();
  return activeOrder.run(++lastOrder, run);
}
