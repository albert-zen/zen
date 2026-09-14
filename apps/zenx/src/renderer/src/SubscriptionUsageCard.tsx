import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SubscriptionUsage,
  SubscriptionQuotaWindow,
} from "../../main/subscription-usage.js";

type Query =
  | { identity: string; status: "loading" | "error" }
  | { identity: string; status: "ready"; usage: SubscriptionUsage };
export function SubscriptionUsageCard({
  providerProfileId,
  accountId,
  authenticated,
}: {
  providerProfileId: string | null;
  accountId: string | undefined;
  authenticated: boolean;
}) {
  const identity = `${providerProfileId ?? ""}:${accountId ?? ""}:${authenticated}`;
  const available = authenticated && !!providerProfileId && !!accountId;
  const [query, setQuery] = useState<Query | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(() => {
    const request = ++generation.current;
    if (!available || !providerProfileId) {
      setQuery(null);
      return;
    }
    setQuery({ identity, status: "loading" });
    void window.zenx.settings
      .readSubscriptionUsage(providerProfileId)
      .then((usage) => {
        if (generation.current !== request) return;
        setQuery(
          usage.accountId === accountId
            ? { identity, status: "ready", usage }
            : { identity, status: "error" },
        );
      })
      .catch(() => {
        if (generation.current === request)
          setQuery({ identity, status: "error" });
      });
  }, [identity, available, providerProfileId, accountId]);
  useEffect(() => {
    refresh();
    return () => {
      generation.current++;
    };
  }, [refresh]);
  const current = query?.identity === identity ? query : null;
  const loading = available && (!current || current.status === "loading");
  return (
    <section
      className="page-card settings-card subscription-usage-card"
      aria-label="Subscription usage"
    >
      <div className="settings-card-head">
        <div>
          <h3>Subscription usage</h3>
          <p>Quota windows for the ChatGPT account signed in to ZenX.</p>
        </div>
        <button
          type="button"
          className="quiet-button"
          disabled={!available || loading}
          onClick={refresh}
          aria-label="Refresh subscription usage"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {!available ? (
        <p className="settings-note">
          Sign in with OpenAI to view your subscription usage.
        </p>
      ) : loading ? (
        <p className="settings-note" role="status">
          Loading subscription usage…
        </p>
      ) : current?.status === "error" ? (
        <p className="quota-error" role="alert">
          Could not load usage. Check your connection or sign in again, then
          refresh.
        </p>
      ) : current?.status === "ready" ? (
        <>
          <div className="quota-meta">
            <span>
              {current.usage.planType
                ? `${current.usage.planType} plan`
                : "Plan not provided"}
            </span>
            <span>Updated {formatTime(current.usage.fetchedAt)}</span>
          </div>
          <div className="quota-limits">
            {current.usage.limits
              .filter((limit) => limit.primary || limit.secondary)
              .map((limit, index) => (
                <section
                  className="quota-limit"
                  key={`${limit.id}-${index}`}
                  aria-label={limit.name ?? limit.id}
                >
                  <h4>{limit.name ?? limit.id}</h4>
                  <div className="quota-windows">
                    {limit.primary ? (
                      <QuotaWindow window={limit.primary} />
                    ) : null}
                    {limit.secondary ? (
                      <QuotaWindow window={limit.secondary} />
                    ) : null}
                  </div>
                </section>
              ))}
          </div>
        </>
      ) : null}
    </section>
  );
}
function QuotaWindow({ window }: { window: SubscriptionQuotaWindow }) {
  const remaining =
    window.usedPercent === null
      ? null
      : Math.max(0, Math.min(100, 100 - window.usedPercent));
  const label = windowLabel(window.windowDurationSeconds);
  return (
    <div className="quota-window">
      <span className="quota-window-label">{label}</span>
      <div className="quota-amount">
        <strong>
          {remaining === null
            ? "Remaining not provided"
            : `${formatPercent(remaining)}% remaining`}
        </strong>
        <span>
          {window.usedPercent === null
            ? "Usage not provided"
            : `${formatPercent(window.usedPercent)}% used`}
        </span>
      </div>
      {remaining === null ? (
        <div className="quota-unknown-bar" aria-hidden="true" />
      ) : (
        <progress
          max={100}
          value={remaining}
          aria-label={`${label} remaining`}
        />
      )}
      <span className="quota-reset">
        {window.resetsAt === null
          ? "Reset time not provided"
          : `Resets ${formatTime(window.resetsAt * 1000)}`}
      </span>
    </div>
  );
}
function windowLabel(seconds: number | null): string {
  if (seconds === null) return "Quota window";
  if (seconds % 86400 === 0) return `${seconds / 86400}-day window`;
  if (seconds % 3600 === 0) return `${seconds / 3600}-hour window`;
  if (seconds % 60 === 0) return `${seconds / 60}-minute window`;
  return `${seconds}-second window`;
}
function formatPercent(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(
    value,
  );
}
function formatTime(milliseconds: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(milliseconds));
}
