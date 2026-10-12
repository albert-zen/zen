import { i18n } from "./i18n.js";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("settings");
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
      aria-label={t("subscriptionUsageCard.subscriptionUsage")}
    >
      <div className="settings-card-head">
        <div>
          <h3>{t("subscriptionUsageCard.subscriptionUsage2")}</h3>
          <p>
            {t(
              "subscriptionUsageCard.quotaWindowsForTheChatgptAccountSignedInTo",
            )}
          </p>
        </div>
        <button
          type="button"
          className="quiet-button"
          disabled={!available || loading}
          onClick={refresh}
          aria-label={t("subscriptionUsageCard.refreshSubscriptionUsage")}
        >
          {loading
            ? t("subscriptionUsageCard.refreshing")
            : t("subscriptionUsageCard.refresh")}
        </button>
      </div>
      {!available ? (
        <p className="settings-note">
          {t(
            "subscriptionUsageCard.signInWithOpenaiToViewYourSubscriptionUsage",
          )}
        </p>
      ) : loading ? (
        <p className="settings-note" role="status">
          {t("subscriptionUsageCard.loadingSubscriptionUsage")}
        </p>
      ) : current?.status === "error" ? (
        <p className="quota-error" role="alert">
          {t(
            "subscriptionUsageCard.couldNotLoadUsageCheckYourConnectionOrSign",
          )}
        </p>
      ) : current?.status === "ready" ? (
        <>
          <div className="quota-meta">
            <span>
              {current.usage.planType
                ? t("subscriptionUsageCard.plan", {
                    name: current.usage.planType,
                  })
                : t("subscriptionUsageCard.planNotProvided")}
            </span>
            <span>
              {t("subscriptionUsageCard.updated")}{" "}
              {formatTime(current.usage.fetchedAt)}
            </span>
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
  const { t } = useTranslation("settings");
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
            ? t("subscriptionUsageCard.remainingNotProvided")
            : t("subscriptionUsageCard.percentRemaining", {
                value: formatPercent(remaining),
              })}
        </strong>
        <span>
          {window.usedPercent === null
            ? t("subscriptionUsageCard.usageNotProvided")
            : t("subscriptionUsageCard.percentUsed", {
                value: formatPercent(window.usedPercent),
              })}
        </span>
      </div>
      {remaining === null ? (
        <div className="quota-unknown-bar" aria-hidden="true" />
      ) : (
        <progress
          max={100}
          value={remaining}
          aria-label={t("subscriptionUsageCard.windowRemaining", {
            name: label,
          })}
        />
      )}
      <span className="quota-reset">
        {window.resetsAt === null
          ? t("subscriptionUsageCard.resetTimeNotProvided")
          : t("subscriptionUsageCard.resets", {
              time: formatTime(window.resetsAt * 1000),
            })}
      </span>
    </div>
  );
}
function windowLabel(seconds: number | null): string {
  if (seconds === null)
    return i18n.t("settings:subscriptionUsageCard.quotaWindow");
  if (seconds % 86400 === 0)
    return i18n.t("settings:subscriptionUsageCard.dayWindow", {
      count: seconds / 86400,
    });
  if (seconds % 3600 === 0)
    return i18n.t("settings:subscriptionUsageCard.hourWindow", {
      count: seconds / 3600,
    });
  if (seconds % 60 === 0)
    return i18n.t("settings:subscriptionUsageCard.minuteWindow", {
      count: seconds / 60,
    });
  return i18n.t("settings:subscriptionUsageCard.secondWindow", {
    count: seconds,
  });
}
function formatPercent(value: number): string {
  return new Intl.NumberFormat(i18n.resolvedLanguage, {
    maximumFractionDigits: 1,
  }).format(value);
}
function formatTime(milliseconds: number): string {
  return new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(milliseconds));
}
