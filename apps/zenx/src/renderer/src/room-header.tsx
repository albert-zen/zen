import React, { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** An App-owned presentation slot, scoped to the currently selected Room route. */
export const RoomHeaderContext = createContext<{
  roomId: string | null;
  element: HTMLElement | null;
} | null>(null);

export function RoomHeaderActions({
  roomId,
  primary,
  children,
  fallback,
}: {
  roomId: string;
  primary: boolean;
  children: ReactNode;
  fallback: ReactNode;
}) {
  const target = useContext(RoomHeaderContext);
  if (!primary || target === null) return fallback;
  if (!target.element || target.roomId !== roomId) return null;
  return createPortal(
    <div className="room-title-actions">{children}</div>,
    target.element,
  );
}
