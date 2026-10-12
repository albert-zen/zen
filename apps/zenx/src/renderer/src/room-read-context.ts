import { createContext } from "react";

/** Local display evidence from the trusted Room surface, never a Room receipt. */
export const RoomReadContext = createContext<
  ((roomId: string, messageId: string | null) => void) | null
>(null);
