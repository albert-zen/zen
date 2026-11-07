/** Disposable synthetic-only observation. Never imported by production. */
export function instrumentSteerReader(source) {
  const probes = [
    [
      "const pauseFollowing = useCallback(() => {",
      "pause",
      "shouldFollowRef.current",
    ],
    [
      "const followBottom = useCallback(() => {",
      "follow",
      "shouldFollowRef.current",
    ],
    [
      "onWheel={(event) => {",
      "react-wheel",
      "shouldFollowRef.current, deltaY: event.deltaY, nested: isNestedTranscriptScroll(event.target, event.currentTarget)",
    ],
  ];
  for (const [needle, kind, values] of probes) {
    if (source.split(needle).length !== 2)
      throw Error(`Diagnostic requires one exact reader probe: ${kind}`);
    source = source.replace(
      needle,
      `${needle}\nglobalThis.__steerRecord?.(${JSON.stringify(kind)}, {following: ${values}});`,
    );
  }
  return source;
}

export function installSteerScrollDiagnostic() {
  const entries = [];
  let dropped = 0;
  const record = (kind, data) => {
    if (entries.length >= 500) {
      dropped++;
      return;
    }
    entries.push({ at: performance.now(), kind, ...data });
  };
  Object.assign(globalThis, {
    __steerRecord: record,
    __steerScrollTrace: {
      entries,
      get dropped() {
        return dropped;
      },
    },
  });
  const owns = (node) => node instanceof Element && node.matches(".messages");
  const descriptor = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollTop",
  );
  if (!descriptor?.get || !descriptor.set)
    throw Error("Missing native scrollTop descriptor");
  Object.defineProperty(Element.prototype, "scrollTop", {
    ...descriptor,
    set(value) {
      if (owns(this))
        record("scrollTop-write", {
          before: descriptor.get.call(this),
          value,
          stack: new Error().stack,
        });
      descriptor.set.call(this, value);
    },
  });
  const scrollTo = Element.prototype.scrollTo;
  Element.prototype.scrollTo = function (...args) {
    if (owns(this))
      record("scrollTo-write", {
        before: this.scrollTop,
        args,
        stack: new Error().stack,
      });
    return Reflect.apply(scrollTo, this, args);
  };
  for (const type of ["wheel", "scroll"]) {
    document.addEventListener(
      type,
      (event) => {
        const node = document.querySelector(".messages");
        if (
          !node ||
          !(event.target instanceof Node) ||
          !node.contains(event.target)
        )
          return;
        record(`native-${type}`, {
          top: node.scrollTop,
          trusted: event.isTrusted,
          deltaY: event.deltaY,
        });
      },
      { capture: true, passive: true },
    );
  }
}
