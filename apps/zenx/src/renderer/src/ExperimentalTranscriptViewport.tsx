import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import {
  protectedTranscriptRows,
  readTranscriptAnchor,
  type TranscriptAnchor,
} from "./transcript-viewport-pins.js";

export interface VirtualTranscriptRow {
  key: string;
  content: ReactNode;
}
export interface VirtualTranscriptHandle {
  /** Materialize one canonical row, without mounting intervening history. */
  reveal(key: string): Promise<boolean>;
}
interface Props extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children" | "onScroll"
> {
  rows: readonly VirtualTranscriptRow[];
  header: ReactNode;
  footer: ReactNode;
  viewport: RefObject<HTMLDivElement | null>;
  controller: RefObject<VirtualTranscriptHandle | null>;
  position: {
    virtualAnchor: TranscriptAnchor | null;
    scroll: { following: boolean } | null;
  };
  onViewportScroll(node: HTMLDivElement, layoutCorrection: boolean): void;
  onContentSettled(): void;
}

/** WIP, opt-in viewport. Legend owns the only scroll node; ZenX owns follow intent. */
export function ExperimentalTranscriptViewport({
  rows,
  header,
  footer,
  viewport,
  controller,
  position,
  onViewportScroll,
  onContentSettled,
  ...attributes
}: Props) {
  const list = useRef<LegendListRef | null>(null);
  const latest = useRef({ onViewportScroll, onContentSettled, rows, position });
  latest.current = { onViewportScroll, onContentSettled, rows, position };
  const [pins, setPins] = useState<string[]>([]);
  const [target, setTarget] = useState<string | null>(
    position.virtualAnchor?.key ?? null,
  );
  const generation = useRef(0);
  const selecting = useRef(false);
  const readerUntil = useRef(0);
  const saved = useRef(position.virtualAnchor);
  const initialIndex = saved.current
    ? rows.findIndex((row) => row.key === saved.current?.key)
    : -1;
  const attach = useCallback(
    (value: LegendListRef | null) => {
      list.current = value;
      const node = value?.getScrollableNode();
      viewport.current = node instanceof window.HTMLDivElement ? node : null;
    },
    [viewport],
  );

  useLayoutEffect(() => {
    const node = viewport.current;
    const instance = list.current;
    if (!node || !instance) return;
    let alive = true;
    let settleFrame = 0;
    let finishFrame = 0;
    const frames = new Map<number, (alive: boolean) => void>();
    const nextFrame = () =>
      new Promise<boolean>((resolve) => {
        const id = requestAnimationFrame(() => {
          frames.delete(id);
          resolve(alive);
        });
        frames.set(id, resolve);
      });
    const protect = (sync = false) => {
      const keys = protectedTranscriptRows(node, selecting.current);
      const update = () =>
        setPins((old) =>
          old.length === keys.length && old.every((key, i) => key === keys[i])
            ? old
            : keys,
        );
      if (sync) flushSync(update);
      else update();
    };
    const settle = () => {
      cancelAnimationFrame(settleFrame);
      cancelAnimationFrame(finishFrame);
      settleFrame = requestAnimationFrame(() => {
        finishFrame = requestAnimationFrame(() => {
          if (alive) latest.current.onContentSettled();
        });
      });
    };
    const userInput = () => {
      generation.current++;
      readerUntil.current = performance.now() + 180;
      setTarget(null);
    };
    const pointer = (event: PointerEvent) => {
      userInput();
      selecting.current = event.button === 0;
      protect(true); // Keep potential range rows before a scroll can recycle them.
    };
    const release = () => {
      selecting.current = false;
      protect();
    };
    const selection = () => protect();
    const scroll = () => {
      const correction =
        performance.now() > readerUntil.current && !selecting.current;
      latest.current.onViewportScroll(node, correction);
      if (!saved.current)
        latest.current.position.virtualAnchor = readTranscriptAnchor(node);
    };
    const beforeScroll = () => protect(true);
    const restore = async (key: string, offset: number, version: number) => {
      const index = latest.current.rows.findIndex((row) => row.key === key);
      if (index < 0) return false;
      setTarget(key);
      await instance.scrollToIndex({ index, animated: false, viewPosition: 0 });
      if (!(await nextFrame()) || generation.current !== version) return false;
      const row = Array.from(
        node.querySelectorAll<HTMLElement>("[data-transcript-row-key]"),
      ).find((row) => row.dataset.transcriptRowKey === key);
      if (!row) return false;
      node.scrollTop +=
        row.getBoundingClientRect().top -
        node.getBoundingClientRect().top -
        offset;
      latest.current.onViewportScroll(node, true);
      return true;
    };
    controller.current = {
      reveal: (key) => restore(key, 0, ++generation.current),
    };
    node.addEventListener("scroll", beforeScroll, {
      capture: true,
      passive: true,
    });
    node.addEventListener("scroll", scroll, { passive: true });
    node.addEventListener("wheel", userInput, { capture: true, passive: true });
    node.addEventListener("keydown", userInput, true);
    node.addEventListener("pointerdown", pointer, true);
    node.addEventListener("focusin", selection, true);
    node.addEventListener("focusout", selection, true);
    node.ownerDocument.addEventListener("pointerup", release);
    node.ownerDocument.addEventListener("pointercancel", release);
    node.ownerDocument.addEventListener("selectionchange", selection);
    const state = instance.getState();
    const unsubscribe = [
      state.listen("totalSize", settle),
      state.listen("footerSize", settle),
      state.listen("headerSize", settle),
    ];
    if (saved.current && position.scroll?.following === false) {
      const anchor = saved.current;
      void restore(anchor.key, anchor.offset, generation.current).finally(
        () => {
          if (alive) {
            saved.current = null;
            setTarget(null);
          }
        },
      );
    } else {
      saved.current = null;
      settle();
    }
    return () => {
      alive = false;
      generation.current++;
      controller.current = null;
      for (const [id, resolve] of frames) {
        cancelAnimationFrame(id);
        resolve(false);
      }
      cancelAnimationFrame(settleFrame);
      cancelAnimationFrame(finishFrame);
      unsubscribe.forEach((stop) => stop());
      node.removeEventListener("scroll", beforeScroll, true);
      node.removeEventListener("scroll", scroll);
      node.removeEventListener("wheel", userInput, true);
      node.removeEventListener("keydown", userInput, true);
      node.removeEventListener("pointerdown", pointer, true);
      node.removeEventListener("focusin", selection, true);
      node.removeEventListener("focusout", selection, true);
      node.ownerDocument.removeEventListener("pointerup", release);
      node.ownerDocument.removeEventListener("pointercancel", release);
      node.ownerDocument.removeEventListener("selectionchange", selection);
    };
  }, [controller, position, viewport]);

  return (
    <LegendList
      {...attributes}
      className={`${attributes.className ?? ""} experimental-transcript-viewport`}
      style={{ ...attributes.style, overflowAnchor: "none", padding: 0 }}
      ref={attach}
      data={rows}
      keyExtractor={(row) => row.key}
      renderItem={({ item }) => (
        <div
          className="virtual-transcript-row"
          data-transcript-row-key={item.key}
        >
          {item.content}
        </div>
      )}
      recycleItems={false}
      estimatedItemSize={280}
      drawDistance={720}
      alwaysRender={{ keys: [...pins, ...(target ? [target] : [])] }}
      maintainScrollAtEnd={false}
      maintainVisibleContentPosition={{ data: false, size: true }}
      initialScrollAtEnd={position.scroll?.following !== false}
      initialScrollIndex={initialIndex >= 0 ? initialIndex : undefined}
      ListHeaderComponent={
        <div className="virtual-transcript-header">
          <p className="virtual-transcript-warning" role="status">
            Experimental virtual transcript. Native Find and Select All cover
            mounted history only.
          </p>
          {header}
        </div>
      }
      ListFooterComponent={
        <div className="virtual-transcript-footer">{footer}</div>
      }
      onItemSizeChanged={() => latest.current.onContentSettled()}
    />
  );
}

/** Preserve the standard DOM path unless this WIP is explicitly enabled for the tab. */
export function TranscriptViewport({
  experimental,
  children,
  ...props
}: Props & { experimental: boolean; children: ReactNode }) {
  if (experimental) return <ExperimentalTranscriptViewport {...props} />;
  const {
    rows: _rows,
    header: _header,
    footer: _footer,
    viewport,
    controller: _controller,
    position: _position,
    onViewportScroll,
    onContentSettled: _settled,
    ...attributes
  } = props;
  return (
    <div
      {...attributes}
      ref={viewport}
      onScroll={(event) => onViewportScroll(event.currentTarget, false)}
    >
      {children}
    </div>
  );
}
