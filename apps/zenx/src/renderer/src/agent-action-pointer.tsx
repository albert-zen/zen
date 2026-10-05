import React, { useEffect, useRef, useState } from "react";
import type { ComputerActionPointer } from "../../main/capabilities/computer-provider.js";

const POINTER_LIFETIME_MS = 3_000;

/** A short-lived semantic destination marker, never an input device. */
export function AgentActionPointer({
  targetKey,
  actionId,
  pointer,
  width,
  height,
  capturedAt,
  windowWidth,
  windowHeight,
}: {
  targetKey: string;
  actionId: string;
  pointer?: ComputerActionPointer;
  width: number;
  height: number;
  capturedAt: string;
  windowWidth?: number;
  windowHeight?: number;
}) {
  const [trail, setTrail] = useState<
    Array<ComputerActionPointer & { actionId: string }>
  >([]);
  const svg = useRef<SVGSVGElement>(null);
  const [cursorScale, setCursorScale] = useState(1);
  useEffect(() => {
    setTrail([]);
  }, [targetKey]);
  useEffect(() => {
    if (!pointer || !validPointer(pointer, Date.now())) {
      setTrail([]);
      return;
    }
    setTrail((previous) => {
      const current = previous.filter(
        (point) =>
          validPointer(point, Date.now()) &&
          point.windowWidth === pointer.windowWidth &&
          point.windowHeight === pointer.windowHeight,
      );
      if (current.at(-1)?.actionId === actionId) return current;
      return [...current, { ...pointer, actionId }].slice(-8);
    });
  }, [targetKey, actionId, pointer]);
  useEffect(() => {
    if (trail.length === 0) return;
    const timer = setTimeout(
      () => {
        setTrail((current) =>
          current.filter((point) => validPointer(point, Date.now())),
        );
      },
      Math.max(
        0,
        Date.parse(trail[0]!.capturedAt) + POINTER_LIFETIME_MS - Date.now(),
      ) + 1,
    );
    return () => clearTimeout(timer);
  }, [trail]);

  const latest = trail.at(-1);
  const geometryMatches =
    !latest ||
    ((windowWidth === undefined || windowWidth === latest.windowWidth) &&
      (windowHeight === undefined || windowHeight === latest.windowHeight) &&
      Math.abs(width / height - latest.windowWidth / latest.windowHeight) <=
        0.02);
  useEffect(() => {
    if (!geometryMatches) setTrail([]);
  }, [geometryMatches]);
  useEffect(() => {
    const element = svg.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const bounds = element.getBoundingClientRect();
      if (bounds.width > 0 && bounds.height > 0)
        setCursorScale(Math.max(width / bounds.width, height / bounds.height));
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, [width, height, Boolean(latest)]);
  if (
    !latest ||
    !validPointer(latest, Date.now()) ||
    width <= 0 ||
    height <= 0 ||
    Date.parse(capturedAt) < Date.parse(latest.capturedAt) ||
    !geometryMatches
  )
    return null;
  const x = latest.x * width;
  const y = latest.y * height;
  // SVG and the contained screenshot share the same viewport/letterboxing.
  return (
    <svg
      ref={svg}
      className="agent-action-pointer"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      focusable="false"
      data-action={latest.action}
    >
      <polyline
        className="agent-action-trail"
        points={trail
          .map((point) => `${point.x * width},${point.y * height}`)
          .join(" ")}
        fill="none"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
      <g
        className="agent-action-cursor"
        transform={`translate(${x} ${y}) scale(${cursorScale})`}
      >
        <circle
          className="agent-action-ring"
          r="13"
          fill="none"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d="M0 0 L0 23 L6 17 L11 27 L16 24 L11 15 L20 15 Z"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
        <text
          x={latest.x > 0.8 ? -10 : 23}
          y={latest.y > 0.9 ? -14 : 34}
          textAnchor={latest.x > 0.8 ? "end" : "start"}
        >
          Agent
        </text>
      </g>
    </svg>
  );
}

function validPointer(pointer: ComputerActionPointer, now: number): boolean {
  const age = now - Date.parse(pointer.capturedAt);
  return (
    Number.isFinite(age) &&
    age >= 0 &&
    age < POINTER_LIFETIME_MS &&
    (pointer.action === "press" || pointer.action === "set_value") &&
    Number.isFinite(pointer.x) &&
    pointer.x >= 0 &&
    pointer.x <= 1 &&
    Number.isFinite(pointer.y) &&
    pointer.y >= 0 &&
    pointer.y <= 1 &&
    Number.isFinite(pointer.windowWidth) &&
    pointer.windowWidth > 0 &&
    Number.isFinite(pointer.windowHeight) &&
    pointer.windowHeight > 0
  );
}
