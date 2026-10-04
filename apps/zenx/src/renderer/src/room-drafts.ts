import type { RoomQuote } from "../../main/trigger-types.js";
import {
  createContext,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
/** App-owned transient Room drafts survive switching between conversation kinds. */
export const RoomDraftContext = createContext<{
  drafts: Record<string, string>;
  intentRevisions?: RefObject<
    Record<
      string,
      { roomId: string; revision: number | null; settled: boolean }
    >
  >;
  replies?: Record<string, RoomQuote | undefined>;
  setReplies?: Dispatch<SetStateAction<Record<string, RoomQuote | undefined>>>;
  revisions: RefObject<Record<string, number>>;
  setDrafts: Dispatch<SetStateAction<Record<string, string>>>;
} | null>(null);
