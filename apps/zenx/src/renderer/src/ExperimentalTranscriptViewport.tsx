import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  useCallback,
  useLayoutEffect,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import {
  isNestedTranscriptScroll,
  protectedTranscriptRows,
  readTranscriptAnchor,
  type TranscriptAnchor,
} from "./transcript-viewport-pins.js";
import {
  alignTranscriptSelectionAnchor,
  ownsNativeTranscriptSelection,
  transcriptSelectionIntersects,
} from "./native-transcript-selection.js";

export interface VirtualTranscriptRow {
  key: string;
  content: ReactNode;
}
export interface TranscriptRevealOwnership {
  isCurrent(): boolean;
  cancel(): void;
}
export interface MaterializedTranscriptRow extends TranscriptRevealOwnership {
  element: HTMLElement;
}
export interface VirtualTranscriptHandle {
  /** Materialize one canonical row, without mounting intervening history. */
  reveal(key: string, onRevealed?: () => void): Promise<boolean>;
  /** Capture cancellation for this request only; stale cleanup cannot cancel a newer source. */
  captureReveal(): TranscriptRevealOwnership;
  /** A user source action needs its exact DOM target synchronously, not a Promise. */
  materialize(
    key: string,
    prepare: () => void,
    onRevealed?: () => void,
  ): MaterializedTranscriptRow | null;
}
interface Props extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children" | "onScroll" | "onLoad"
> {
  rows: readonly VirtualTranscriptRow[];
  header: ReactNode;
  footer: ReactNode;
  viewport: RefObject<HTMLDivElement | null>;
  controller: RefObject<VirtualTranscriptHandle | null>;
  listRef?: RefObject<LegendListRef | null>;
  position: {
    virtualAnchor: TranscriptAnchor | null;
    scroll: { following: boolean } | null;
  };
  onViewportScroll(node: HTMLDivElement, layoutCorrection: boolean): void;
  onContentSettled(): void;
  onNativeSelectionStart?(): void;
  onBeforeViewportChange?(viewport: HTMLDivElement): void;
  onViewportChanged?(): void;
}

/** WIP, opt-in viewport. Legend owns the only scroll node; ZenX owns follow intent. */
export function ExperimentalTranscriptViewport({
  rows,
  header,
  footer,
  viewport,
  controller,
  listRef,
  position,
  onViewportScroll,
  onContentSettled,
  onNativeSelectionStart: _selectionStarted,
  onBeforeViewportChange: _beforeViewportChange,
  onViewportChanged: _viewportChanged,
  ...attributes
}: Props) {
  const list = useRef<LegendListRef | null>(null);
  const notifySettled = useRef<() => void>(() => {});
  const latest = useRef({ onViewportScroll, onContentSettled, rows, position });
  latest.current = { onViewportScroll, onContentSettled, rows, position };
  const [pins, setPins] = useState<string[]>([]);
  const [target, setTarget] = useState<string | null>(
    position.virtualAnchor?.key ?? null,
  );
  const generation = useRef(0);
  const selecting = useRef(false);
  const saved = useRef(position.virtualAnchor);
  const initial = useRef({
    following: position.scroll?.following !== false,
    index: saved.current
      ? rows.findIndex((row) => row.key === saved.current?.key)
      : -1,
  });
  const attach = useCallback(
    (value: LegendListRef | null) => {
      list.current = value;
      if (listRef) listRef.current = value;
      const node = value?.getScrollableNode();
      viewport.current = node instanceof window.HTMLDivElement ? node : null;
    },
    [listRef, viewport],
  );

  useLayoutEffect(() => {
    const node = viewport.current;
    const instance = list.current;
    if (!node || !instance) return;
    let alive = true;
    let settleFrame = 0;
    let finishFrame = 0;
    const frames = new Map<number, (alive: boolean) => void>();
    const pending = new Set<() => void>();
    let readerScrolling = false;
    let pointerActive = false;
    let readerTimer: ReturnType<typeof setTimeout> | undefined;
    const scrollEnd = () => {
      readerScrolling = false;
    };
    const keepReaderActive = () => {
      readerScrolling = true;
      clearTimeout(readerTimer);
      readerTimer = setTimeout(scrollEnd, 220);
    };
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
      if (settleFrame || finishFrame) return;
      settleFrame = requestAnimationFrame(() => {
        settleFrame = 0;
        finishFrame = requestAnimationFrame(() => {
          finishFrame = 0;
          if (alive) latest.current.onContentSettled();
        });
      });
    };
    notifySettled.current = settle;
    const userInput = (event: Event) => {
      if (isNestedTranscriptScroll(event.target, node)) return false;
      keepReaderActive();
      if (pending.size > 0) {
        for (const cancel of pending) cancel();
        // A public offset command supersedes Legend's queued index correction.
        void instance.scrollToOffset({
          offset: node.scrollTop,
          animated: false,
        });
      }
      generation.current++;
      setTarget(null);
      return true;
    };
    const pointer = (event: PointerEvent) => {
      if (!userInput(event)) return;
      pointerActive = true;
      const target = event.target instanceof Element ? event.target : null;
      selecting.current =
        event.button === 0 &&
        !!target?.closest("[data-transcript-row-key]") &&
        !target.closest("button,a,input,textarea,select,[role='button']");
      protect(true); // Keep potential range rows before a scroll can recycle them.
    };
    const release = () => {
      pointerActive = false;
      selecting.current = false;
      protect();
    };
    const selection = () => protect();
    const scroll = () => {
      if (readerScrolling) keepReaderActive();
      const correction =
        pending.size > 0 || (!readerScrolling && !pointerActive);
      latest.current.onViewportScroll(node, correction);
      // Legend can correct only an offset after its final size notification.
      // Re-check the app's existing follow intent after that correction too.
      if (correction) settle();
      if (!saved.current)
        latest.current.position.virtualAnchor = readTranscriptAnchor(node);
    };
    const beforeScroll = () => protect(true);
    const restore = async (
      key: string,
      offset: number,
      version: number,
      onRevealed?: () => void,
    ) => {
      const index = latest.current.rows.findIndex((row) => row.key === key);
      if (index < 0) {
        setTarget(null);
        return false;
      }
      setTarget(key);
      let cancel = () => {};
      const cancelled = new Promise<false>((resolve) => {
        cancel = () => resolve(false);
      });
      pending.add(cancel);
      try {
        const settled = await Promise.race([
          instance
            .scrollToIndex({ index, animated: false, viewPosition: 0 })
            .then(() => true),
          cancelled,
        ]);
        if (!settled || !alive || generation.current !== version) return false;
        if (!(await nextFrame()) || generation.current !== version)
          return false;
        const row = Array.from(
          node.querySelectorAll<HTMLElement>("[data-transcript-row-key]"),
        ).find((row) => row.dataset.transcriptRowKey === key);
        if (!row) return false;
        node.scrollTop +=
          row.getBoundingClientRect().top -
          node.getBoundingClientRect().top -
          offset;
        latest.current.onViewportScroll(node, true);
        if (!alive || generation.current !== version) return false;
        onRevealed?.();
        return true;
      } catch {
        return false;
      } finally {
        pending.delete(cancel);
        if (alive && generation.current === version) setTarget(null);
      }
    };
    const cancelNavigation = () => {
      if (pending.size > 0) {
        for (const cancel of pending) cancel();
        void instance.scrollToOffset({
          offset: node.scrollTop,
          animated: false,
        });
      }
      generation.current++;
      setTarget(null);
    };
    const externalInput = (event: Event) => {
      if (
        pending.size === 0 ||
        (event.target instanceof Node && node.contains(event.target))
      )
        return;
      cancelNavigation();
    };
    const captureReveal = (): TranscriptRevealOwnership => {
      const version = generation.current;
      return {
        isCurrent: () => alive && generation.current === version,
        cancel: () => {
          if (alive && generation.current === version) cancelNavigation();
        },
      };
    };
    controller.current = {
      captureReveal,
      reveal: (key, onRevealed) => {
        protect(true);
        for (const cancel of pending) cancel();
        return restore(key, 0, ++generation.current, onRevealed);
      },
      materialize: (key, prepare, onRevealed) => {
        if (!latest.current.rows.some((row) => row.key === key)) return null;
        protect(true);
        for (const cancel of pending) cancel();
        const version = ++generation.current;
        flushSync(() => {
          prepare();
          setTarget(key);
        });
        const element = Array.from(
          node.querySelectorAll<HTMLElement>("[data-transcript-row-key]"),
        ).find((row) => row.dataset.transcriptRowKey === key);
        if (!element) {
          cancelNavigation();
          return null;
        }
        void restore(key, 0, version, onRevealed);
        return {
          element,
          isCurrent: () => alive && generation.current === version,
          cancel: () => {
            if (alive && generation.current === version) cancelNavigation();
          },
        };
      },
    };
    node.addEventListener("scroll", beforeScroll, {
      capture: true,
      passive: true,
    });
    node.addEventListener("scroll", scroll, { passive: true });
    node.addEventListener("scrollend", scrollEnd, { passive: true });
    node.addEventListener("wheel", userInput, { capture: true, passive: true });
    node.addEventListener("keydown", userInput, true);
    node.addEventListener("pointerdown", pointer, true);
    node.addEventListener("focusin", selection, true);
    node.addEventListener("focusout", selection, true);
    node.ownerDocument.addEventListener("pointerup", release);
    node.ownerDocument.addEventListener("pointercancel", release);
    node.ownerDocument.addEventListener("selectionchange", selection);
    for (const type of ["pointerdown", "keydown", "wheel"])
      node.ownerDocument.addEventListener(type, externalInput, {
        capture: true,
        passive: true,
      });
    const state = instance.getState();
    const unsubscribe = [
      state.listen("totalSize", settle),
      state.listen("footerSize", settle),
      state.listen("headerSize", settle),
    ];
    if (saved.current && position.scroll?.following === false) {
      const anchor = saved.current;
      saved.current = null;
      void restore(anchor.key, anchor.offset, generation.current);
    } else {
      saved.current = null;
      settle();
    }
    return () => {
      alive = false;
      clearTimeout(readerTimer);
      generation.current++;
      controller.current = null;
      for (const cancel of pending) cancel();
      notifySettled.current = () => {};
      for (const [id, resolve] of frames) {
        cancelAnimationFrame(id);
        resolve(false);
      }
      cancelAnimationFrame(settleFrame);
      cancelAnimationFrame(finishFrame);
      unsubscribe.forEach((stop) => stop());
      node.removeEventListener("scroll", beforeScroll, true);
      node.removeEventListener("scroll", scroll);
      node.removeEventListener("scrollend", scrollEnd);
      node.removeEventListener("wheel", userInput, true);
      node.removeEventListener("keydown", userInput, true);
      node.removeEventListener("pointerdown", pointer, true);
      node.removeEventListener("focusin", selection, true);
      node.removeEventListener("focusout", selection, true);
      node.ownerDocument.removeEventListener("pointerup", release);
      node.ownerDocument.removeEventListener("pointercancel", release);
      node.ownerDocument.removeEventListener("selectionchange", selection);
      for (const type of ["pointerdown", "keydown", "wheel"])
        node.ownerDocument.removeEventListener(type, externalInput, true);
    };
  }, [controller, position, viewport]);

  return (
    <LegendList
      {...attributes}
      className={`${attributes.className ?? ""} experimental-transcript-viewport`}
      style={{ ...attributes.style, overflowAnchor: "none", padding: 0 }}
      ref={attach}
      contentContainerClassName="virtual-transcript-content"
      data={rows}
      dataVersion={JSON.stringify([target, pins])}
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
      initialScrollAtEnd={initial.current.following}
      initialScrollIndex={
        initial.current.index >= 0 ? initial.current.index : undefined
      }
      ListHeaderComponent={
        <div className="virtual-transcript-header">
          <p className="virtual-transcript-warning" role="status">
            Experimental virtual transcript. Native operations remain under
            validation.
          </p>
          {header}
        </div>
      }
      ListFooterComponent={
        <div className="virtual-transcript-footer">{footer}</div>
      }
      onItemSizeChanged={() => notifySettled.current()}
    />
  );
}

/** Preserve the standard DOM path unless this WIP is explicitly enabled for the tab. */
export function TranscriptViewport({
  experimental,
  children,
  ...props
}: Props & { experimental: boolean; children: ReactNode }) {
  if (experimental) return <NativeSelectableTranscriptViewport {...props} />;
  const {
    rows: _rows,
    header: _header,
    footer: _footer,
    viewport,
    controller: _controller,
    listRef: _listRef,
    position: _position,
    onViewportScroll,
    onContentSettled: _settled,
    onNativeSelectionStart: _selectionStarted,
    onBeforeViewportChange: _beforeViewportChange,
    onViewportChanged: _viewportChanged,
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

/** Explicit native Select All temporarily uses the normal canonical DOM order. */
function NativeSelectableTranscriptViewport(props: Props) {
  const [complete, setComplete] = useState(false);
  const completeRef = useRef(false);
  const anchor = useRef<TranscriptAnchor | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const selectionEpoch = useRef(0);
  const lastViewport = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const node = props.viewport.current;
    if (lastViewport.current !== node) {
      lastViewport.current = node;
      latest.current.onViewportChanged?.();
    }
  });
  useEffect(() => {
    const bridge = window.zenx?.nativeEditing;
    if (!bridge) return;
    let alive = true;
    let cancelFrame = 0;
    const unsubscribe = bridge.onPrepareSelectAll(() => {
      if (!alive) return false;
      const node = latest.current.viewport.current;
      if (!node || !ownsNativeTranscriptSelection(node)) return false;
      cancelAnimationFrame(cancelFrame);
      ++selectionEpoch.current;
      if (!completeRef.current) {
        latest.current.onBeforeViewportChange?.(node);
        latest.current.onNativeSelectionStart?.();
        latest.current.controller.current?.captureReveal().cancel();
        anchor.current = readTranscriptAnchor(node);
        latest.current.position.virtualAnchor = anchor.current;
        completeRef.current = true;
        flushSync(() => setComplete(true));
      }
      return true;
    });
    const unsubscribeCancelled = bridge.onSelectAllCancelled(() => {
      const epoch = selectionEpoch.current;
      cancelAnimationFrame(cancelFrame);
      cancelFrame = requestAnimationFrame(() => {
        if (!alive || epoch !== selectionEpoch.current || !completeRef.current)
          return;
        const current = latest.current;
        const node = current.viewport.current;
        if (node && transcriptSelectionIntersects(node)) return;
        if (node) current.onBeforeViewportChange?.(node);
        if (node) anchor.current = readTranscriptAnchor(node) ?? anchor.current;
        current.position.virtualAnchor = anchor.current;
        if (current.position.scroll) current.position.scroll.following = false;
        completeRef.current = false;
        setComplete(false);
      });
    });
    return () => {
      alive = false;
      ++selectionEpoch.current;
      cancelAnimationFrame(cancelFrame);
      unsubscribe();
      unsubscribeCancelled();
    };
  }, []);
  useLayoutEffect(() => {
    if (!complete) return;
    const node = props.viewport.current;
    if (!node) return;
    const document = node.ownerDocument;
    alignTranscriptSelectionAnchor(node, anchor.current);
    props.onViewportScroll(node, true);
    let armed = false;
    let frame = 0;
    let alive = true;
    let navigation = 0;
    const frames = new Map<number, (value: boolean) => void>();
    const cancelNavigation = () => {
      navigation++;
      for (const [frame, resolve] of frames) {
        cancelAnimationFrame(frame);
        resolve(false);
      }
      frames.clear();
    };
    const ownership = (version: number): TranscriptRevealOwnership => ({
      isCurrent: () => alive && node.isConnected && navigation === version,
      cancel: () => {
        if (navigation === version) cancelNavigation();
      },
    });
    const reveal = (
      key: string,
      prepare?: () => void,
      onRevealed?: () => void,
    ) => {
      if (!latest.current.rows.some((row) => row.key === key)) return null;
      cancelNavigation();
      const version = navigation;
      if (prepare) flushSync(prepare);
      const element = Array.from(
        node.querySelectorAll<HTMLElement>("[data-transcript-row-key]"),
      ).find((row) => row.dataset.transcriptRowKey === key);
      if (!element) return null;
      const owner = ownership(version);
      const settled = new Promise<boolean>((resolve) => {
        const frame = requestAnimationFrame(() => {
          frames.delete(frame);
          if (
            !owner.isCurrent() ||
            !element.isConnected ||
            !node.contains(element)
          ) {
            resolve(false);
            return;
          }
          try {
            element.scrollIntoView({ block: "start", behavior: "auto" });
            latest.current.onViewportScroll(node, true);
            if (!owner.isCurrent()) {
              resolve(false);
              return;
            }
            onRevealed?.();
            resolve(true);
          } catch {
            resolve(false);
          }
        });
        frames.set(frame, resolve);
      });
      return { element, ...owner, settled };
    };
    const handle: VirtualTranscriptHandle = {
      captureReveal: () => ownership(navigation),
      reveal: (key, onRevealed) =>
        reveal(key, undefined, onRevealed)?.settled ?? Promise.resolve(false),
      materialize: (key, prepare, onRevealed) =>
        reveal(key, prepare, onRevealed),
    };
    props.controller.current = handle;
    for (const type of ["pointerdown", "keydown", "wheel"])
      document.addEventListener(type, cancelNavigation, true);
    const finish = () => {
      if (!alive || !completeRef.current) return;
      if (transcriptSelectionIntersects(node)) {
        armed = true;
        return;
      }
      // The native command follows the synchronous commit via the owned bridge.
      // Ignore the old virtual DOM's transient collapsed selection until then.
      if (!armed) return;
      latest.current.onBeforeViewportChange?.(node);
      anchor.current = readTranscriptAnchor(node) ?? anchor.current;
      props.position.virtualAnchor = anchor.current;
      if (props.position.scroll) props.position.scroll.following = false;
      completeRef.current = false;
      setComplete(false);
    };
    const selection = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(finish);
    };
    const focus = () => {
      if (!ownsNativeTranscriptSelection(node)) {
        armed = true;
        selection();
      }
    };
    document.addEventListener("selectionchange", selection);
    document.addEventListener("focusin", focus);
    // A committed Selection, rather than a timer, owns the full DOM lifetime.
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", selection);
      document.removeEventListener("focusin", focus);
      cancelNavigation();
      if (props.controller.current === handle) props.controller.current = null;
      for (const type of ["pointerdown", "keydown", "wheel"])
        document.removeEventListener(type, cancelNavigation, true);
    };
  }, [complete, props.position, props.viewport, props.controller]);
  if (!complete) return <ExperimentalTranscriptViewport {...props} />;
  const {
    rows,
    header,
    footer,
    viewport,
    controller: _controller,
    listRef: _listRef,
    position: _position,
    onViewportScroll,
    onContentSettled: _settled,
    onNativeSelectionStart: _selectionStarted,
    onBeforeViewportChange: _beforeViewportChange,
    onViewportChanged: _viewportChanged,
    ...attributes
  } = props;
  return (
    <div
      {...attributes}
      ref={viewport}
      data-native-transcript-selection="complete"
      onScroll={(event) => onViewportScroll(event.currentTarget, false)}
    >
      <div className="messages-inner">
        {header}
        <div className="transcript-history">
          {rows.map((row) => (
            <div key={row.key} data-transcript-row-key={row.key}>
              {row.content}
            </div>
          ))}
        </div>
        {footer}
      </div>
    </div>
  );
}
