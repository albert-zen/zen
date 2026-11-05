import { createHash } from "node:crypto";

const bounded = (value, limit) =>
  typeof value === "string" ? value.slice(0, limit) : undefined;

/** Fixture-only, passive observation of the real method. No replacement result or promise. */
export function observeFramePreparation(prototype, publish = () => {}) {
  const original = prototype.prepare;
  const receipt = {
    calls: 0,
    successes: 0,
    failures: 0,
    observerErrors: 0,
    head: [],
    tail: [],
  };
  const record = (read) => {
    try {
      const value = read();
      if (receipt.head.length < 4) receipt.head.push(value);
      else {
        if (receipt.tail.length === 4) receipt.tail.shift();
        receipt.tail.push(value);
      }
      publish(value);
    } catch {
      receipt.observerErrors++;
    }
  };
  const failed = (call, error) => {
    receipt.failures++;
    record(() => ({
      call,
      outcome: "original-error",
      name: bounded(error?.name, 128),
      message: bounded(error?.message, 1024),
      stack: bounded(error?.stack, 4096),
    }));
  };
  const wrapper = function (...args) {
    const call = ++receipt.calls;
    let result;
    try {
      result = Reflect.apply(original, this, args);
    } catch (error) {
      failed(call, error);
      throw error;
    }
    // Observing settlement must neither replace nor await the production promise.
    try {
      result.then(
        (capture) => {
          receipt.successes++;
          record(() => {
            const snapshot = capture?.snapshot;
            return {
              call,
              outcome: "original-success",
              available: snapshot !== undefined,
              ...(snapshot
                ? {
                    fingerprint: createHash("sha256")
                      .update(JSON.stringify(snapshot))
                      .digest("hex"),
                    focusId: bounded(snapshot.focusId, 512),
                    focusUnsupported: bounded(snapshot.focusUnsupported, 128),
                    inputRevision: snapshot.inputRevision,
                    layoutRevision: snapshot.layoutRevision,
                    frameDocuments: snapshot.frameDocuments?.length,
                    frameOwnerScanComplete: snapshot.frameOwnerScanComplete,
                    viewport: Object.fromEntries(
                      [
                        "width",
                        "height",
                        "deviceScaleFactor",
                        "scrollX",
                        "scrollY",
                        "visualScale",
                        "visualOffsetX",
                        "visualOffsetY",
                      ]
                        .filter((key) =>
                          Number.isFinite(snapshot.viewport?.[key]),
                        )
                        .map((key) => [key, snapshot.viewport[key]]),
                    ),
                  }
                : {}),
            };
          });
        },
        (error) => failed(call, error),
      );
    } catch {
      receipt.observerErrors++;
    }
    return result;
  };
  prototype.prepare = wrapper;
  return {
    receipt,
    restore() {
      if (prototype.prepare === wrapper) prototype.prepare = original;
    },
  };
}
