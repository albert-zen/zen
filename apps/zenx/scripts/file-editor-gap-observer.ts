import type { EditorView } from "@codemirror/view";

/** Fixture-only layout observer. Reads may force browser layout; never a fix. */
export function observeFileEditorGaps(
  view: EditorView,
  append: (receipt: unknown) => void,
) {
  const win = view.dom.ownerDocument.defaultView!;
  let sequence = 0;
  let frame = 0;
  let destroyed = false;
  const rect = (element: Element) => {
    const r = element.getBoundingClientRect();
    return {
      top: r.top,
      bottom: r.bottom,
      left: r.left,
      right: r.right,
      height: r.height,
    };
  };
  const elementState = (element: HTMLElement) => {
    const style = win.getComputedStyle(element);
    return {
      className: element.className,
      inlineStyle: element.getAttribute("style"),
      inlineHeight: element.style.height,
      inlineHeightPriority: element.style.getPropertyPriority("height"),
      rect: rect(element),
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
      computed: {
        height: style.height,
        blockSize: style.blockSize,
        writingMode: style.writingMode,
        boxSizing: style.boxSizing,
        contentVisibility: style.contentVisibility,
        transitionProperty: style.transitionProperty,
        transitionDuration: style.transitionDuration,
        transitionDelay: style.transitionDelay,
        animationName: style.animationName,
        animationDuration: style.animationDuration,
        animationDelay: style.animationDelay,
        minHeight: style.minHeight,
        maxHeight: style.maxHeight,
        display: style.display,
        position: style.position,
        contain: style.contain,
        overflowAnchor: style.overflowAnchor,
        flexShrink: style.flexShrink,
        transform: style.transform,
      },
      animations:
        element.getAnimations?.().map((animation) => ({
          playState: animation.playState,
          currentTime: String(animation.currentTime),
          startTime: String(animation.startTime),
          timing: animation.effect?.getComputedTiming(),
        })) ?? [],
    };
  };
  const snapshot = () => ({
    connected: view.dom.isConnected,
    head: view.state.selection.main.head,
    documentLength: view.state.doc.length,
    hiddenAncestor: !!view.dom.closest("[hidden]"),
    scrollTopBeforeLayout: view.scrollDOM.scrollTop,
    viewport: { ...view.viewport },
    contentHeight: view.contentHeight,
    scroll: elementState(view.scrollDOM),
    content: elementState(view.contentDOM),
    gaps: Array.from(
      view.contentDOM.querySelectorAll<HTMLElement>(".cm-gap"),
      (gap) => ({
        index: Array.from(view.contentDOM.children).indexOf(gap),
        ...elementState(gap),
        previous: gap.previousElementSibling
          ? {
              className: gap.previousElementSibling.className,
              rect: rect(gap.previousElementSibling),
            }
          : null,
        next: gap.nextElementSibling
          ? {
              className: gap.nextElementSibling.className,
              rect: rect(gap.nextElementSibling),
            }
          : null,
      }),
    ),
    childCount: view.contentDOM.children.length,
    edges: Array.from(view.contentDOM.children)
      .filter((_, i, children) => i < 2 || i >= children.length - 2)
      .map((element) => ({
        className: element.className,
        text: element.textContent?.slice(-100),
        rect: rect(element),
      })),
  });
  const record = (kind: string, detail?: unknown) => {
    if (destroyed) return;
    const start = win.performance.now();
    const geometry = snapshot();
    append({
      kind,
      sequence: ++sequence,
      time: start,
      readDuration: win.performance.now() - start,
      detail,
      geometry,
    });
  };
  const onScroll = (event: Event) =>
    record(`dom-${event.type}`, {
      isTrusted: event.isTrusted,
      eventTime: event.timeStamp,
    });
  view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
  view.scrollDOM.addEventListener("scrollend", onScroll, { passive: true });
  const observer = new win.MutationObserver((mutations) => {
    record(
      "content-mutation",
      mutations.slice(0, 30).map((mutation) => ({
        type: mutation.type,
        target: (mutation.target as Element).className,
        attribute: mutation.attributeName,
        oldValue: mutation.oldValue,
        added: Array.from(mutation.addedNodes, (node) =>
          node.nodeType === 1 ? (node as Element).className : node.nodeName,
        ),
        removed: Array.from(mutation.removedNodes, (node) =>
          node.nodeType === 1 ? (node as Element).className : node.nodeName,
        ),
      })),
    );
  });
  observer.observe(view.contentDOM, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ["style", "class"],
  });
  return {
    record,
    afterScrollRequest() {
      win.cancelAnimationFrame(frame);
      let remaining = 12;
      const sample = () => {
        record("after-scroll-request-frame", { remaining });
        if (!destroyed && --remaining > 0)
          frame = win.requestAnimationFrame(sample);
      };
      frame = win.requestAnimationFrame(sample);
    },
    destroy() {
      destroyed = true;
      observer.disconnect();
      win.cancelAnimationFrame(frame);
      view.scrollDOM.removeEventListener("scroll", onScroll);
      view.scrollDOM.removeEventListener("scrollend", onScroll);
    },
  };
}
