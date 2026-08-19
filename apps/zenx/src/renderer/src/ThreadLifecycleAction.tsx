import { Icon } from "./icons.js";

export function ThreadLifecycleAction({
  archived,
  busy,
  error = null,
  hasActiveTurn,
  onChange,
}: {
  archived: boolean;
  busy: boolean;
  error?: string | null;
  hasActiveTurn: boolean;
  onChange(): Promise<void>;
}) {
  const blocked = !archived && hasActiveTurn;
  const label = archived
    ? busy
      ? "Unarchiving…"
      : "Unarchive"
    : busy
      ? "Archiving…"
      : "Archive";
  return (
    <div className="thread-lifecycle-control">
      <button
        className="thread-lifecycle-action"
        type="button"
        aria-describedby={blocked ? "archive-active-turn-help" : undefined}
        disabled={busy || blocked}
        title={
          blocked
            ? "Wait for the active Turn to finish before archiving."
            : undefined
        }
        onClick={() => void onChange()}
      >
        <Icon name={archived ? "restore" : "archive"} />
        <span>{label}</span>
      </button>
      {blocked ? (
        <span className="sr-only" id="archive-active-turn-help">
          Wait for the active Turn to finish before archiving.
        </span>
      ) : null}
      {error === null ? null : (
        <span className="thread-action-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
