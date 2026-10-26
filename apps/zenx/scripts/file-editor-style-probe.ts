import type { EditorView } from "@codemirror/view";

/** Matching selectors, not a computed cascade claim. Called only after failure. */
export function matchingFileEditorStyles(elements: Element[]) {
  const document = elements[0]?.ownerDocument;
  const win = document?.defaultView;
  if (!document || !win) return null;
  const matches: unknown[] = [];
  const errors: string[] = [];
  let truncated = false;
  const visit = (
    rules: CSSRuleList,
    source: unknown,
    conditions: unknown[],
  ) => {
    for (const rule of Array.from(rules)) {
      const styleRule = rule as CSSStyleRule;
      if (styleRule.selectorText) {
        const targets = elements.flatMap((element, index) => {
          try {
            return element.matches(styleRule.selectorText) ? [index] : [];
          } catch {
            return [];
          }
        });
        if (targets.length) {
          if (matches.length >= 200) {
            truncated = true;
          } else {
            matches.push({
              source,
              conditions,
              targets,
              selector: styleRule.selectorText,
              declarations: styleRule.style.cssText,
            });
          }
        }
      }
      const group = rule as CSSGroupingRule & { conditionText?: string };
      if (group.cssRules) {
        const condition = group.conditionText;
        visit(group.cssRules, source, [
          ...conditions,
          {
            type: rule.constructor.name,
            condition,
            matches:
              typeof win.CSSMediaRule === "function" &&
              rule instanceof win.CSSMediaRule
                ? win.matchMedia(condition ?? "").matches
                : typeof win.CSSSupportsRule === "function" &&
                    rule instanceof win.CSSSupportsRule
                  ? win.CSS.supports(condition ?? "")
                  : null,
          },
        ]);
      }
    }
  };
  for (const [index, sheet] of Array.from(document.styleSheets).entries()) {
    const owner = sheet.ownerNode as Element | null;
    const source = {
      index,
      href: sheet.href,
      ownerTag: owner?.tagName,
      hasNonce: !!owner?.hasAttribute("nonce"),
      disabled: sheet.disabled,
      media: sheet.media?.mediaText,
    };
    try {
      visit(sheet.cssRules, source, []);
    } catch (error) {
      errors.push(`${index}: ${String(error)}`);
    }
  }
  return {
    scope:
      "Matching selectors only; conditions and stylesheet state retained, no claim that every match wins the cascade.",
    elements: elements.map((element) => ({
      tag: element.tagName,
      className: element.className,
      inlineStyle: element.getAttribute("style"),
    })),
    matches,
    truncated,
    errors,
  };
}

/** Never writes an editor-owned node. The driver persists its failure first. */
export async function probeFileEditorStylesAfterFailure(
  view: EditorView,
  frameDeadlineMs = 250,
) {
  const document = view.dom.ownerDocument;
  const win = document.defaultView!;
  const start = win.performance.now();
  const read = (element: HTMLElement) => {
    const style = win.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      time: win.performance.now(),
      inlineStyle: element.getAttribute("style"),
      inlineHeight: element.style.height,
      height: style.height,
      blockSize: style.blockSize,
      writingMode: style.writingMode,
      display: style.display,
      boxSizing: style.boxSizing,
      contain: style.contain,
      contentVisibility: style.contentVisibility,
      transition: style.transition,
      animation: style.animation,
      rect: { top: rect.top, bottom: rect.bottom, height: rect.height },
    };
  };
  const originalState = () => ({
    head: view.state.selection.main.head,
    viewport: { ...view.viewport },
    scrollTop: view.scrollDOM.scrollTop,
    scrollHeight: view.scrollDOM.scrollHeight,
    pageScrollHeight: document.documentElement.scrollHeight,
    pageScrollWidth: document.documentElement.scrollWidth,
  });
  const gaps = Array.from(
    view.contentDOM.querySelectorAll<HTMLElement>(".cm-gap"),
  );
  const ancestors: Element[] = [];
  for (
    let element: Element | null = view.contentDOM;
    element;
    element = element.parentElement
  )
    ancestors.push(element);
  const original = {
    state: originalState(),
    gaps: gaps.map(read),
    styles: matchingFileEditorStyles([...gaps, ...ancestors]),
  };
  const host = document.createElement("div");
  host.dataset.syntheticAfterFailureStyleProbe = "true";
  // Independent fixed, clipped, size/layout-contained subtree. No editor parent,
  // no content focus, no page scroll area contribution, no shared class mutation.
  Object.assign(host.style, {
    position: "fixed",
    left: "-1000000px",
    top: "0px",
    width: "8px",
    height: "8px",
    contain: "strict",
    overflow: "hidden",
    visibility: "hidden",
    pointerEvents: "none",
  });
  document.body.append(host);
  const probes = [];
  try {
    for (const kind of ["plain", "gap-class", "scoped-editable-gap"] as const) {
      const wrapper = document.createElement("div");
      let parent = wrapper;
      if (kind === "scoped-editable-gap") {
        wrapper.className = view.dom.className;
        const scroller = document.createElement("div");
        scroller.className = "cm-scroller";
        const content = document.createElement("div");
        content.className = view.contentDOM.className;
        content.contentEditable = "true";
        wrapper.append(scroller);
        scroller.append(content);
        parent = content;
      }
      host.append(wrapper);
      const element = document.createElement("div");
      if (kind !== "plain") element.className = "cm-gap";
      element.style.height = "50px";
      parent.append(element);
      const initial = read(element);
      element.style.height = "40000px";
      const immediate = read(element);
      const nextFrame = await new Promise<number>((resolve, reject) => {
        const deadline = win.setTimeout(() => {
          win.cancelAnimationFrame(frame);
          reject(
            new Error(
              `After-failure probe frame exceeded ${frameDeadlineMs} ms; no native assertion changed`,
            ),
          );
        }, frameDeadlineMs);
        const frame = win.requestAnimationFrame((time) => {
          win.clearTimeout(deadline);
          resolve(time);
        });
      });
      const afterFrame = read(element);
      const fresh = document.createElement("div");
      fresh.className = element.className;
      fresh.style.height = "40000px";
      parent.append(fresh);
      probes.push({
        kind,
        initial,
        immediate,
        nextFrame,
        afterFrame,
        fresh: read(fresh),
        styles: matchingFileEditorStyles([element, parent, wrapper, host]),
      });
      wrapper.remove();
    }
  } finally {
    host.remove();
  }
  return {
    scope:
      "After the original failed assertion was persisted. Independent synthetic div CSSOM property updates only; no actual editor gap, scroll, selection or CodeMirror measurement writes. Layout reads and inserted isolated subtree may still affect timing; never a fix or pass condition.",
    start,
    end: win.performance.now(),
    original,
    probes,
    after: originalState(),
    removed: !host.isConnected,
  };
}
