import React, {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { Thread, ThreadItem } from "../../protocol-client/index.js";
import { MessageSourceLink } from "./message-source-navigation.js";
import {
  projectToolActionTargets,
  type ToolActionTarget,
} from "./tool-action-targets.js";
const Targets = createContext<ReadonlyMap<string, ToolActionTarget>>(new Map());
export function ToolActionTargetsProvider({
  thread,
  children,
}: {
  thread: Thread | null;
  children: ReactNode;
}) {
  const targets = useMemo(
    () =>
      projectToolActionTargets(thread?.id ?? "", thread?.canonicalItems ?? []),
    [thread?.id, thread?.canonicalItems],
  );
  return <Targets.Provider value={targets}>{children}</Targets.Provider>;
}
/** A sibling action, never a nested button or an alias for the details disclosure. */
export function ToolActionLink({ item }: { item: ThreadItem }) {
  const { t } = useTranslation("shell");
  const action = useContext(Targets).get(item.id);
  if (!action) return null;
  const label = t(
    action.label === "message" ? "toolOpenMessage" : "toolOpenTrigger",
  );
  return (
    <div className="tool-action-target">
      {"target" in action ? (
        <MessageSourceLink target={action.target} label={label} />
      ) : (
        <small className="message-source-status">
          {t(
            action.unavailable === "remote"
              ? "toolTargetRemoteUnavailable"
              : "toolTargetMissing",
          )}
        </small>
      )}
    </div>
  );
}
