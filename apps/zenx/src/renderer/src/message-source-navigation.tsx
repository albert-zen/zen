import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./icons.js";

/** Canonical provenance, never a route or identity parsed from message text. */
export type MessageSourceTarget =
  | {
      kind: "thread";
      id: string;
      deviceId?: string;
      itemId?: string;
      returnBound?: boolean;
    }
  | { kind: "trigger"; id: string; threadId?: string };
export type MessageSourceNavigator = (
  target: MessageSourceTarget,
  owner: { threadId: string; isCurrent(): boolean },
) => Promise<void>;
export const MessageSourceNavigationContext =
  createContext<MessageSourceNavigator | null>(null);
export const MessageSourceViewportContext = createContext<string | null>(null);
export const TRIGGER_SOURCE_ROUTE = "/plugins/zenx-triggers/triggers";
export function triggerSourceRoute(id: string): string {
  return `${TRIGGER_SOURCE_ROUTE}?${new URLSearchParams({ triggerId: id })}`;
}

export function MessageSourceLink({
  target,
  label,
  className = "",
  active = true,
}: {
  target: MessageSourceTarget;
  label: string;
  className?: string;
  active?: boolean;
}) {
  const { t } = useTranslation("shell");
  const navigate = useContext(MessageSourceNavigationContext);
  const threadId = useContext(MessageSourceViewportContext);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const identity = JSON.stringify([threadId, target, active]);
  const current = useRef({ identity, version: 0 });
  if (current.current.identity !== identity)
    current.current = { identity, version: current.current.version + 1 };
  const mounted = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    inFlight.current = false;
    setPending(false);
    setError(null);
  }, [identity]);
  const reason =
    target.kind === "thread" &&
    target.deviceId !== undefined &&
    !target.returnBound
      ? t("sourceRemoteUnavailable")
      : !target.id
        ? t("sourceTargetMissing")
        : !navigate || !threadId
          ? t("sourceNavigationUnavailable")
          : null;
  const run = async () => {
    if (!active || reason || !navigate || !threadId || inFlight.current) return;
    const version = current.current.version;
    const ownsRequest = () =>
      mounted.current && current.current.version === version;
    const isCurrent = () =>
      ownsRequest() &&
      button.current?.isConnected === true &&
      button.current.closest("[hidden], [aria-hidden='true']") === null;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await navigate(target, { threadId, isCurrent });
    } catch (failure) {
      if (isCurrent())
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (ownsRequest()) {
        inFlight.current = false;
        setPending(false);
      }
    }
  };
  return (
    <span className="message-source-line">
      <button
        ref={button}
        type="button"
        className={`thread-message-sender message-source-link ${className}`}
        aria-disabled={reason !== null || pending}
        aria-busy={pending}
        aria-describedby={reason || error ? errorId : undefined}
        title={reason ? `${label} · ${reason}` : label}
        onClick={() => void run()}
      >
        <Icon
          name={target.kind === "trigger" ? "trigger" : "conversation"}
          size={12}
        />
        <span>{label}</span>
      </button>
      {reason || error ? (
        <small
          id={errorId}
          className="message-source-status"
          role={error ? "alert" : undefined}
        >
          {error ?? reason}
        </small>
      ) : null}
    </span>
  );
}
