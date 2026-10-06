import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import {
  parseFleetInvitation,
  type FleetInvitation,
  type FleetReadiness,
} from "../../fleet-invitation.js";
import type {
  FleetSettingsApi,
  FleetSettingsSnapshot,
} from "./FleetSettings.js";
import { Select } from "./ui/controls.js";

interface SetupProps {
  api: FleetSettingsApi;
  snapshot: FleetSettingsSnapshot;
  disabled: boolean;
  onBusy(busy: boolean): void;
  onChanged(): Promise<unknown>;
  embedded?: boolean;
  onClose?(): void;
}

/** Invitations live only in this human interaction, never in a model or draft. */
export function FleetConnectionSetup({
  api,
  snapshot,
  disabled,
  onBusy,
  onChanged,
  embedded = false,
  onClose,
}: SetupProps) {
  const { t, i18n } = useTranslation("settings");
  const translateMessage = (value: FleetOnboardingMessage) =>
    typeof value === "string" ? value : t(value.key, value.values);
  const [open, setOpen] = useState(embedded);
  const [raw, setRaw] = useState("");
  const [invitation, setInvitation] = useState<FleetInvitation | null>(null);
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [access, setAccess] = useState<"read" | "control">("read");
  const [shell, setShell] = useState(false);
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FleetOnboardingMessage | null>(null);
  const [notice, setNotice] = useState<FleetOnboardingMessage | null>(null);
  const [completed, setCompleted] = useState(false);
  const [readiness, setReadiness] = useState<FleetReadiness | null>(null);
  const mounted = useRef(false);
  const flight = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const review = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (open && !invitation) input.current?.focus();
  }, [open, invitation]);
  useEffect(() => {
    if (invitation) review.current?.focus();
  }, [invitation]);
  useEffect(() => {
    if (!invitation) return;
    const timer = window.setTimeout(
      () => {
        setInvitation(null);
        setRaw("");
        setTrusted(false);
        setError({ key: "fleetOnboarding.invitationExpired" });
      },
      Math.max(0, invitation.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [invitation]);
  const clear = () => {
    setOpen(embedded);
    setRaw("");
    setInvitation(null);
    setTrusted(false);
    setAccess("read");
    setShell(false);
    setDescription("");
    trigger.current?.focus();
  };
  const run = async (operation: () => Promise<void>) => {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    onBusy(true);
    setError(null);
    setNotice(null);
    try {
      await operation();
    } catch (reason) {
      if (mounted.current) setError(message(reason));
    } finally {
      flight.current = false;
      onBusy(false);
      if (mounted.current) setBusy(false);
    }
  };
  const pair = async () => {
    const chosen = invitation;
    if (!chosen || !trusted) return;
    if (chosen.expiresAt <= Date.now())
      throw new Error("This invitation expired. Ask for a fresh invitation.");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(id) || id === "local")
      throw new Error(
        "Use a machine ID with letters, numbers, dashes or underscores.",
      );
    if (snapshot.config.devices.some((device) => device.id === id))
      throw new Error(
        "This machine ID is already configured. Choose another ID or review the existing device.",
      );
    if (!label.trim()) throw new Error("Enter a machine name.");
    // A consumed/unknown invitation is never blindly replayed. The target owns
    // its one-use admission, and the saved vault owns the permanent token.
    clear();
    await api.pair({
      id,
      label: label.trim(),
      description,
      endpoint: chosen.endpoint,
      hostId: chosen.hostId,
      code: chosen.code,
      access,
      shellEnabled: access === "control" && shell,
    });
    if (mounted.current) {
      setCompleted(true);
      setNotice({ key: "fleetOnboarding.pairedChecking" });
    }
    try {
      await onChanged();
      await api.test(id);
      await onChanged();
      if (mounted.current)
        setNotice({
          key: "fleetOnboarding.pairedReachable",
          values: { name: label.trim() },
        });
    } catch (reason) {
      if (mounted.current) {
        setNotice({ key: "fleetOnboarding.pairedCheckFailed" });
        setError(message(reason));
      }
    }
  };
  return (
    <section
      className={
        embedded ? "fleet-invitation-setup" : "page-card settings-card"
      }
      aria-label={t("fleetOnboarding.connectMachine")}
    >
      {!embedded ? (
        <div className="settings-card-head">
          <div>
            <h3>{t("fleetOnboarding.connectMachine")}</h3>
            <p>{t("fleetOnboarding.setupDescription")}</p>
          </div>
          <button
            ref={trigger}
            className="secondary-button"
            disabled={disabled || busy}
            onClick={() => {
              setOpen(true);
              setError(null);
              setNotice(null);
            }}
          >
            {t("fleetOnboarding.useInvitation")}
          </button>
        </div>
      ) : null}
      <p className="settings-note">
        {embedded
          ? t("fleetConnection.invitationDescription")
          : t("fleetOnboarding.endpointRequirement")}
      </p>

      {error ? (
        <p className="settings-error" role="alert">
          {translateMessage(error)}
        </p>
      ) : null}
      {notice ? <p role="status">{translateMessage(notice)}</p> : null}
      {embedded && completed ? (
        <div className="fleet-actions settings-actions">
          <button className="primary-button" disabled={busy} onClick={onClose}>
            {t("fleetConnection.done")}
          </button>
          <button
            className="quiet-button"
            disabled={busy}
            onClick={() => {
              setCompleted(false);
              setNotice(null);
              setError(null);
            }}
          >
            {t("fleetConnection.connectAnother")}
          </button>
        </div>
      ) : null}
      {open && !invitation && (!embedded || !completed) ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            try {
              const value = parseFleetInvitation(raw);
              setInvitation(value);
              setRaw("");
              setLabel(value.label);
              setId(uniqueMachineId(value.hostId, snapshot));
              setDescription("");
              setAccess("read");
              setShell(false);
              setTrusted(false);
            } catch (reason) {
              setError(message(reason));
              setRaw("");
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !busy) {
              event.preventDefault();
              clear();
              onClose?.();
            }
          }}
        >
          <label className="field">
            <span>{t("fleetOnboarding.invitation")}</span>
            <input
              ref={input}
              aria-label={t("fleetOnboarding.invitation")}
              type="password"
              autoComplete="off"
              value={raw}
              maxLength={8192}
              onChange={(event) => setRaw(event.target.value)}
              disabled={busy}
            />
          </label>
          <div className="settings-actions fleet-actions">
            <button
              className="primary-button"
              type="submit"
              disabled={busy || !raw.trim()}
            >
              {t("fleetOnboarding.reviewInvitation")}
            </button>
            <button
              className="quiet-button"
              type="button"
              disabled={busy}
              onClick={() => {
                clear();
                onClose?.();
              }}
            >
              {t("fleetOnboarding.cancelInvitation")}
            </button>
          </div>
        </form>
      ) : null}
      <details className="fleet-block-space">
        <summary>{t("fleetOnboarding.prepareWithAgent")}</summary>
        {embedded ? <p>{t("fleetOnboarding.endpointRequirement")}</p> : null}
        <p>{t("fleetOnboarding.preparePrompt")}</p>
        <p>{t("fleetOnboarding.readinessDescription")}</p>
        <button
          className="quiet-button"
          disabled={disabled || busy || !api.readiness}
          onClick={() =>
            void run(async () => {
              const value = await api.readiness!();
              if (mounted.current) setReadiness(value);
            })
          }
        >
          {t("fleetOnboarding.checkSetup")}
        </button>
        {readiness ? (
          <div className="fleet-top-space" role="status">
            <p>
              {t("fleetOnboarding.readinessSummary", {
                credentialStore: readiness.prerequisites.credentialEncryption
                  ? t("fleetOnboarding.credentialsReady")
                  : t("fleetOnboarding.credentialsNeedEncryption"),
                hosting: readiness.host.enabled
                  ? t("fleetOnboarding.hostRunning")
                  : t("fleetOnboarding.hostNotRunning"),
                endpoint: readiness.prerequisites.trustedEndpointConfigured
                  ? t("fleetOnboarding.endpointConfigured")
                  : t("fleetOnboarding.endpointNeedsConfiguration"),
              })}
            </p>
            <ul>
              {readiness.limits.map((limit) => (
                <li key={limit}>
                  {Object.hasOwn(readinessLimitKeys, limit)
                    ? t(readinessLimitKeys[limit]!)
                    : limit}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </details>
      {invitation ? (
        <div
          ref={review}
          tabIndex={-1}
          aria-label={t("fleetOnboarding.reviewMachineInvitation")}
          className="fleet-invitation-review"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !busy) {
              event.preventDefault();
              clear();
              onClose?.();
            }
          }}
        >
          <h4>{t("fleetOnboarding.reviewMachineInvitation")}</h4>
          <p className="fleet-wrap">
            {t("fleetOnboarding.hostId", { hostId: invitation.hostId })}
            <br />
            {t("fleetOnboarding.endpoint", { endpoint: invitation.endpoint })}
            <br />
            {t("fleetOnboarding.expiresAt", {
              time: new Date(invitation.expiresAt).toLocaleString(
                i18n.resolvedLanguage,
              ),
            })}
          </p>
          {isLoopback(invitation.endpoint) ? (
            <p className="settings-note">
              {t("fleetOnboarding.loopbackWarning")}
            </p>
          ) : null}
          <div className="form-grid">
            <label className="field">
              <span>{t("fleetOnboarding.machineId")}</span>
              <input
                aria-label={t("fleetOnboarding.machineId")}
                value={id}
                disabled={busy}
                onChange={(event) => {
                  setId(event.target.value);
                  setTrusted(false);
                }}
              />
            </label>
            <label className="field">
              <span>{t("fleetOnboarding.machineName")}</span>
              <input
                aria-label={t("fleetOnboarding.machineName")}
                value={label}
                disabled={busy}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
            <label className="field wide">
              <span>{t("fleetOnboarding.machineDescription")}</span>
              <textarea
                aria-label={t("fleetOnboarding.machineDescription")}
                rows={3}
                maxLength={4000}
                value={description}
                disabled={busy}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <label className="field">
              <span>{t("fleetOnboarding.access")}</span>
              <Select
                aria-label={t("fleetOnboarding.invitationAccess")}
                value={access}
                disabled={busy}
                onValueChange={(value) => {
                  setAccess(value as "read" | "control");
                  setShell(false);
                  setTrusted(false);
                }}
              >
                <option value="read">{t("fleetOnboarding.readOnly")}</option>
                <option
                  value="control"
                  disabled={invitation.access !== "control"}
                >
                  {t("fleetOnboarding.threadControl")}
                </option>
              </Select>
            </label>
          </div>
          <p className="settings-note">
            {t("fleetOnboarding.verifyHostDescription")}
          </p>
          {invitation.shellEnabled && access === "control" ? (
            <label className="fleet-confirmation">
              <input
                type="checkbox"
                checked={shell}
                disabled={busy}
                onChange={(event) => {
                  setShell(event.target.checked);
                  setTrusted(false);
                }}
              />
              {t("fleetOnboarding.shellConsent")}
            </label>
          ) : null}
          <label className="fleet-confirmation">
            <input
              type="checkbox"
              checked={trusted}
              disabled={busy}
              onChange={(event) => setTrusted(event.target.checked)}
            />
            {access === "control"
              ? shell
                ? t("fleetOnboarding.trustControlShell")
                : t("fleetOnboarding.trustControl")
              : shell
                ? t("fleetOnboarding.trustReadShell")
                : t("fleetOnboarding.trustRead")}
          </label>
          <div className="settings-actions fleet-actions">
            <button
              className="primary-button"
              disabled={busy || !trusted}
              onClick={() => void run(pair)}
            >
              {busy
                ? t("fleetOnboarding.pairing")
                : t("fleetOnboarding.pairAndCheck")}
            </button>
            <button
              className="quiet-button"
              disabled={busy}
              onClick={() => {
                clear();
                onClose?.();
              }}
            >
              {t("fleetOnboarding.cancelInvitation")}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

interface IssuerProps extends SetupProps {
  hostingDirty: boolean;
  onHostStatus(snapshot: FleetSettingsSnapshot): void;
}
export function FleetInvitationIssuer({
  api,
  snapshot,
  disabled,
  hostingDirty,
  onBusy,
  onHostStatus,
}: IssuerProps) {
  const { t, i18n } = useTranslation("settings");
  const translateMessage = (value: FleetOnboardingMessage) =>
    typeof value === "string" ? value : t(value.key, value.values);
  const hosting = snapshot.config.hosting;
  const expected = {
    revision: snapshot.revision,
    hostId: snapshot.host.hostId,
    access: hosting?.access ?? ("read" as const),
    shellEnabled:
      hosting?.access === "control" && hosting.shellEnabled === true,
    relayEndpoint: hosting?.relayEndpoint ?? null,
  };
  const suggested =
    snapshot.host.relayConnected && hosting?.relayEndpoint
      ? hosting.relayEndpoint
      : (hosting?.originEndpoint ?? snapshot.host.url ?? "");
  const [endpoint, setEndpoint] = useState(suggested);
  const [label, setLabel] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [issued, setIssued] = useState<{
    invitation: FleetInvitation;
    serialized: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FleetOnboardingMessage | null>(null);
  const [copied, setCopied] = useState(false);
  const mounted = useRef(false);
  const flight = useRef(false);
  const scope = JSON.stringify([
    expected,
    snapshot.host.enabled,
    hostingDirty,
    suggested,
  ]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setEndpoint(suggested);
    setConfirmed(false);
    setIssued(null);
    setCopied(false);
  }, [scope]);
  useEffect(() => {
    if (!issued) return;
    let cancelled = false;
    let checking = false;
    const expire = window.setTimeout(
      () => {
        setIssued(null);
        setConfirmed(false);
        setError({ key: "fleetOnboarding.issuerExpired" });
      },
      Math.max(0, issued.invitation.expiresAt - Date.now()),
    );
    const timer = window.setInterval(() => {
      if (checking || flight.current) return;
      checking = true;
      void api
        .status()
        .then((value) => {
          if (!cancelled) onHostStatus(value);
        })
        .catch(() => {
          if (!cancelled)
            setError({ key: "fleetOnboarding.clientsRefreshFailed" });
        })
        .finally(() => {
          checking = false;
        });
    }, 3000);
    return () => {
      cancelled = true;
      window.clearTimeout(expire);
      window.clearInterval(timer);
    };
  }, [issued, api, onHostStatus]);
  const create = async () => {
    if (flight.current || !confirmed || !api.hostInvitation) return;
    flight.current = true;
    setBusy(true);
    onBusy(true);
    setError(null);
    setIssued(null);
    setCopied(false);
    const requestedScope = scope;
    try {
      const value = await api.hostInvitation({
        endpoint,
        label: label ?? t("fleetOnboarding.thisMachine"),
        confirmed: true,
        expected,
      });
      if (currentScope.current !== requestedScope) {
        if (mounted.current)
          setError({ key: "fleetOnboarding.sharingScopeChanged" });
        return;
      }
      if (mounted.current) {
        setIssued(value);
        setConfirmed(false);
      }
    } catch (reason) {
      if (mounted.current) setError(message(reason));
    } finally {
      flight.current = false;
      onBusy(false);
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section
      className="fleet-section-space"
      aria-label={t("fleetOnboarding.inviteClient")}
    >
      <h4>{t("fleetOnboarding.inviteClient")}</h4>
      <p>{t("fleetOnboarding.issuerDescription")}</p>
      <div className="form-grid">
        <label className="field">
          <span>{t("fleetOnboarding.invitationEndpoint")}</span>
          <input
            aria-label={t("fleetOnboarding.invitationEndpoint")}
            value={endpoint}
            disabled={disabled || busy}
            onChange={(event) => {
              setEndpoint(event.target.value);
              setConfirmed(false);
              setIssued(null);
            }}
          />
        </label>
        <label className="field">
          <span>{t("fleetOnboarding.invitationMachineName")}</span>
          <input
            aria-label={t("fleetOnboarding.invitationMachineName")}
            value={label ?? t("fleetOnboarding.thisMachine")}
            maxLength={120}
            disabled={disabled || busy}
            onChange={(event) => {
              setLabel(event.target.value);
              setConfirmed(false);
              setIssued(null);
            }}
          />
        </label>
      </div>
      <p className="settings-note">
        {t("fleetOnboarding.issuerEndpointDescription")}
      </p>
      <label className="fleet-confirmation">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={disabled || busy || hostingDirty || !snapshot.host.enabled}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        {hosting?.access === "control"
          ? hosting?.shellEnabled
            ? hosting?.relayEndpoint
              ? t("fleetOnboarding.shareControlShellRelay")
              : t("fleetOnboarding.shareControlShell")
            : hosting?.relayEndpoint
              ? t("fleetOnboarding.shareControlRelay")
              : t("fleetOnboarding.shareControl")
          : hosting?.shellEnabled
            ? hosting?.relayEndpoint
              ? t("fleetOnboarding.shareReadShellRelay")
              : t("fleetOnboarding.shareReadShell")
            : hosting?.relayEndpoint
              ? t("fleetOnboarding.shareReadRelay")
              : t("fleetOnboarding.shareRead")}
      </label>
      <button
        className="secondary-button"
        disabled={
          disabled ||
          busy ||
          hostingDirty ||
          !snapshot.host.enabled ||
          !confirmed ||
          !api.hostInvitation
        }
        onClick={() => void create()}
      >
        {busy
          ? t("fleetOnboarding.creating")
          : t("fleetOnboarding.createInvitation")}
      </button>
      {error ? (
        <p className="settings-error" role="alert">
          {translateMessage(error)}
        </p>
      ) : null}
      {issued ? (
        <div className="fleet-top-space">
          <label className="field">
            <span>{t("fleetOnboarding.shareInvitation")}</span>
            <input
              aria-label={t("fleetOnboarding.shareInvitation")}
              type="password"
              autoComplete="off"
              readOnly
              value={issued.serialized}
              onFocus={(event) => event.target.select()}
            />
          </label>
          <p>
            {t("fleetOnboarding.shareExpiryWarning", {
              time: new Date(issued.invitation.expiresAt).toLocaleString(
                i18n.resolvedLanguage,
              ),
            })}
          </p>
          <div className="settings-actions fleet-actions">
            <button
              className="secondary-button"
              onClick={() => {
                void navigator.clipboard.writeText(issued.serialized).then(
                  () => {
                    if (mounted.current) setCopied(true);
                  },
                  () => {
                    if (mounted.current)
                      setError({ key: "fleetOnboarding.clipboardUnavailable" });
                  },
                );
              }}
            >
              {copied
                ? t("fleetOnboarding.copied")
                : t("fleetOnboarding.copyInvitation")}
            </button>
            <button
              className="quiet-button"
              onClick={() => {
                setIssued(null);
                setCopied(false);
              }}
            >
              {t("fleetOnboarding.hideInvitation")}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
function uniqueMachineId(hostId: string, snapshot: FleetSettingsSnapshot) {
  const base = `machine-${hostId.replace(/[^a-zA-Z0-9_-]/gu, "").slice(0, 32) || "remote"}`;
  let value = base,
    index = 2;
  while (snapshot.config.devices.some((device) => device.id === value))
    value = `${base}-${index++}`;
  return value;
}
function isLoopback(endpoint: string) {
  const host = new URL(endpoint).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}
function message(reason: unknown): FleetOnboardingMessage {
  const value = reason instanceof Error ? reason.message : String(reason);
  const detail = value.replace(
    /^Error invoking remote method 'zenx:fleet:control': (?:Error: )?/u,
    "",
  );
  const key = Object.hasOwn(onboardingErrorKeys, detail)
    ? onboardingErrorKeys[detail]
    : undefined;
  return key ? { key } : detail;
}

type FleetOnboardingMessage =
  string | { key: string; values?: Record<string, string | number> };

// Match only known app-owned messages; preserve unknown remote/service text.
const onboardingErrorKeys: Record<string, string> = {
  "This invitation expired. Ask the target user for a fresh invitation.":
    "fleetOnboarding.invitationExpired",
  "This invitation expired. Ask for a fresh invitation.":
    "fleetOnboarding.invitationExpiredRetry",
  "Use a machine ID with letters, numbers, dashes or underscores.":
    "fleetOnboarding.invalidMachineId",
  "This machine ID is already configured. Choose another ID or review the existing device.":
    "fleetOnboarding.duplicateMachineId",
  "Enter a machine name.": "fleetOnboarding.machineNameRequired",
  "Paired. Checking this machine…": "fleetOnboarding.pairedChecking",
  "Paired, but the connection check failed. The saved trust remains; use Test on the device after addressing the error.":
    "fleetOnboarding.pairedCheckFailed",
  "Invitation expired. Create a fresh one when the other user is ready.":
    "fleetOnboarding.issuerExpired",
  "Could not refresh paired clients. Check Fleet status before sharing again.":
    "fleetOnboarding.clientsRefreshFailed",
  "Fleet Host or sharing scope changed. Refresh, review and confirm before sharing a new invitation.":
    "fleetOnboarding.sharingScopeChanged",
  "Clipboard unavailable. Select the invitation field and copy it using the system Copy action.":
    "fleetOnboarding.clipboardUnavailable",
  "Invalid Fleet invitation": "fleetOnboarding.invalidInvitation",
  "Invalid Fleet invitation expiry": "fleetOnboarding.invalidInvitationExpiry",
  "Fleet invitation expired; request a fresh invitation":
    "fleetOnboarding.parsedInvitationExpired",
  "Invalid Fleet invitation endpoint; use one HTTPS origin":
    "fleetOnboarding.invalidInvitationEndpoint",
};
const readinessLimitKeys: Record<string, string> = {
  "Only user-configured peers are discovered; no automatic network scan, rendezvous or pairing.":
    "fleetOnboarding.configuredPeersOnly",
  "Direct HTTPS needs a certificate trusted by the client and a route to the Host. Listener state and timestamped checks do not prove current client reachability.":
    "fleetOnboarding.httpsReachability",
  "Different networks need routing or a VPN arranged by the user, or an already configured reachable relay. Fleet does not set up routers, VPNs, certificates or relays.":
    "fleetOnboarding.networkPreparation",
  "A relay is a trusted TLS termination point that can see pairing, requests and events; relay transport is not end-to-end encrypted.":
    "fleetOnboarding.relayTrust",
  "Invitations are human-only bearer secrets, expire within five minutes and can pair once. Host and client grants still bound control and shell access.":
    "fleetOnboarding.invitationLimits",
};
