import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  FleetMessageSourceView,
  FleetMessageSourceRequest,
} from "../../main/fleet-settings.js";
import type { FleetThreadLocator } from "../../main/fleet-product.js";
import { Dialog } from "./ui/controls.js";
import { Icon } from "./icons.js";
import { FleetHistory } from "./FleetHistory.js";

export interface RemoteMessageSourceApi {
  messageSource(
    input: FleetMessageSourceRequest,
  ): Promise<FleetMessageSourceView>;
  sourceHistory(input: {
    receipt: FleetMessageSourceRequest;
    locator: FleetThreadLocator;
    cursor?: string;
    itemId?: string;
  }): Promise<Record<string, unknown>>;
  triggerSource(input: {
    receipt: FleetMessageSourceRequest;
    locator: FleetThreadLocator;
    triggerId: string;
  }): Promise<Record<string, unknown>>;
}
interface FullItem {
  id: string;
  raw: string;
  nextCursor: string | null;
  total: number;
}
/** Read-only, target-qualified observation. Never touches the local Composer or selection. */
export function RemoteMessageSourceDialog({
  value,
  onClose,
}: {
  value: FleetMessageSourceView;
  onClose(): void;
}) {
  const { t } = useTranslation("shell");
  const [view, setView] = useState(value);
  const [trigger, setTrigger] = useState<Record<string, unknown> | null>(null);
  const [fullItem, setFullItem] = useState<FullItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setView(value);
    setTrigger(null);
    setFullItem(null);
    setError(null);
    setPending(false);
    return () => {
      generation.current++;
    };
  }, [value]);
  const api = () =>
    (window.zenx as unknown as { fleet: RemoteMessageSourceApi }).fleet;
  const close = () => {
    generation.current++;
    onClose();
  };
  const back = () => {
    generation.current++;
    setTrigger(null);
    setFullItem(null);
    setPending(false);
    setError(null);
  };
  const run = async (operation: (current: () => boolean) => Promise<void>) => {
    const version = ++generation.current;
    setError(null);
    setPending(true);
    try {
      await operation(() => generation.current === version);
    } catch (reason) {
      if (generation.current === version)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (generation.current === version) setPending(false);
    }
  };
  const open = (target: {
    kind: "thread" | "trigger";
    id: string;
    remote?: boolean;
  }) =>
    run(async (current) => {
      if (!target.id || target.remote)
        throw new Error(
          t(target.remote ? "sourceRemoteUnavailable" : "sourceTargetMissing"),
        );
      if (target.kind === "trigger") {
        const result = await api().triggerSource({
          receipt: value.receipt,
          locator: view.locator,
          triggerId: target.id,
        });
        if (current()) {
          setTrigger(result.trigger as Record<string, unknown>);
          setFullItem(null);
        }
      } else {
        const locator = { ...view.locator, threadId: target.id };
        const history = await api().sourceHistory({
          receipt: value.receipt,
          locator,
        });
        if (current()) {
          setView({ receipt: value.receipt, locator, history });
          setTrigger(null);
          setFullItem(null);
        }
      }
    });
  const older = () =>
    run(async (current) => {
      const cursor = view.history.nextCursor;
      if (typeof cursor !== "string") return;
      const history = await api().sourceHistory({
        receipt: value.receipt,
        locator: view.locator,
        cursor,
      });
      if (current())
        setView({
          ...view,
          history: {
            ...history,
            items: [
              ...(history.items as unknown[]),
              ...(view.history.items as unknown[]),
            ],
          },
        });
    });
  const readItem = (id: string, previous?: FullItem) =>
    run(async (current) => {
      const result = await api().sourceHistory({
        receipt: value.receipt,
        locator: view.locator,
        itemId: id,
        ...(previous?.nextCursor ? { cursor: previous.nextCursor } : {}),
      });
      if (
        typeof result.content !== "string" ||
        result.offset !== (previous?.raw.length ?? 0) ||
        typeof result.totalLength !== "number"
      )
        throw new Error(t("sourceNavigationUnavailable"));
      if (current())
        setFullItem({
          id,
          raw: (previous?.raw ?? "") + result.content,
          nextCursor:
            typeof result.nextCursor === "string" ? result.nextCursor : null,
          total: result.totalLength,
        });
    });
  let fullText = fullItem?.raw ?? "";
  if (fullItem && !fullItem.nextCursor) {
    try {
      const item = JSON.parse(fullItem.raw);
      fullText =
        typeof item.text === "string"
          ? item.text
          : JSON.stringify(item, null, 2);
    } catch {
      /* Explicit raw public Item content remains visible. */
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t("sourceRemoteTitle")}
      className="remote-message-source-dialog"
    >
      <header>
        <h2>{t(trigger ? "sourceRemoteTriggerTitle" : "sourceRemoteTitle")}</h2>
        <button
          className="icon-button"
          aria-label={t("panels:close")}
          onClick={close}
        >
          <Icon name="x" />
        </button>
      </header>
      <p className="settings-note">
        {t("sourceRemoteScope", {
          host: view.locator.hostId,
          workspace: view.locator.workspace,
          thread: view.locator.threadId,
        })}
      </p>
      <p className="settings-note">{t("sourceRemoteReadOnly")}</p>
      {error ? <p role="alert">{error}</p> : null}
      {pending ? <p role="status">{t("sourceRemoteLoading")}</p> : null}
      <div className="remote-message-source-content" aria-busy={pending}>
        {trigger || fullItem ? (
          <button className="secondary-button" onClick={back}>
            {t("sourceRemoteBack")}
          </button>
        ) : null}
        {trigger ? (
          <>
            <h3>{String(trigger.label ?? trigger.id)}</h3>
            <p>{t("sourceRemoteTriggerId", { id: String(trigger.id) })}</p>
            <p className="settings-note">
              {t("sourceRemoteTriggerDisclosure")}
            </p>
            <pre>{JSON.stringify(trigger, null, 2)}</pre>
          </>
        ) : fullItem ? (
          <>
            <p>
              {t("sourceFullProgress", {
                loaded: fullItem.raw.length,
                total: fullItem.total,
              })}
            </p>
            <pre>{fullText}</pre>
            {fullItem.nextCursor ? (
              <button
                className="secondary-button"
                disabled={pending}
                onClick={() => void readItem(fullItem.id, fullItem)}
              >
                {t("sourceLoadNextPart")}
              </button>
            ) : null}
          </>
        ) : (
          <>
            {typeof view.history.nextCursor === "string" ? (
              <button
                className="secondary-button"
                disabled={pending}
                onClick={() => void older()}
              >
                {t("sourceLoadOlder")}
              </button>
            ) : null}
            <FleetHistory
              value={view.history}
              onSource={(target) => void open(target)}
              onReadItem={(id) => void readItem(id)}
            />
          </>
        )}
      </div>
    </Dialog>
  );
}
