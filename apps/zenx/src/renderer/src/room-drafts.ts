import {
  createContext,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
/** App-owned transient Room drafts survive switching between conversation kinds. */
export const RoomDraftContext = createContext<{
  drafts: Record<string, string>;
  revisions: RefObject<Record<string, number>>;
  setDrafts: Dispatch<SetStateAction<Record<string, string>>>;
} | null>(null);
