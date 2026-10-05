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
}

/** Invitations live only in this human interaction, never in a model or draft. */
export function FleetConnectionSetup({
  api,
  snapshot,
  disabled,
  onBusy,
  onChanged,
}: SetupProps) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [invitation, setInvitation] = useState<FleetInvitation | null>(null);
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [access, setAccess] = useState<"read" | "control">("read");
  const [shell, setShell] = useState(false);
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
        setError(
          "This invitation expired. Ask the target user for a fresh invitation.",
        );
      },
      Math.max(0, invitation.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [invitation]);
  const clear = () => {
    setOpen(false);
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
    if (mounted.current) setNotice("Paired. Checking this machine…");
    try {
      await onChanged();
      await api.test(id);
      await onChanged();
      if (mounted.current)
        setNotice(
          `Paired and reachable: ${label.trim()}. This was a connection check, not a permanent live session.`,
        );
    } catch (reason) {
      if (mounted.current) {
        setNotice(
          "Paired, but the connection check failed. The saved trust remains; use Test on the device after addressing the error.",
        );
        setError(message(reason));
      }
    }
  };
  return (
    <section
      className="page-card settings-card"
      aria-label="Connect another machine"
    >
      <div className="settings-card-head">
        <div>
          <h3>Connect another machine</h3>
          <p>
            Ask the Agent on that machine to check Fleet readiness. Its user
            creates an invitation, then you review and pair here.
          </p>
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
          Use invitation
        </button>
      </div>
      <p className="settings-note">
        The target must already have a trusted, reachable HTTPS endpoint or a
        configured relay. Machines on unrelated networks cannot find each other
        automatically. Invitations stay in this Settings screen; do not paste
        them into an Agent conversation.
      </p>
      <details className="fleet-block-space">
        <summary>Prepare with an Agent</summary>
        <p>
          Ask: “Check Fleet readiness on this machine and explain what is
          missing. Prepare nonsecret settings only. Let me approve hosting and
          pairing.”
        </p>
        <p>
          The Fleet plugin is bundled for any Agent. Existing disabled choices
          and normal tool permissions remain in effect. The read-only readiness
          tool reports known devices and preparation steps; it cannot install
          certificates, configure networks or create trust.
        </p>
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
          Check this machine’s setup
        </button>
        {readiness ? (
          <div className="fleet-top-space" role="status">
            <p>
              Credential store:{" "}
              {readiness.prerequisites.credentialEncryption
                ? "ready"
                : "needs operating-system encryption"}{" "}
              · Hosting: {readiness.host.enabled ? "running" : "not running"} ·
              Trusted endpoint:{" "}
              {readiness.prerequisites.trustedEndpointConfigured
                ? "configured"
                : "needs configuration"}
            </p>
            <ul>
              {readiness.limits.map((limit) => (
                <li key={limit}>{limit}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </details>
      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {open && !invitation ? (
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
            }
          }}
        >
          <label className="field">
            <span>Invitation</span>
            <input
              ref={input}
              aria-label="Invitation"
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
              Review invitation
            </button>
            <button
              className="quiet-button"
              type="button"
              disabled={busy}
              onClick={clear}
            >
              Cancel invitation
            </button>
          </div>
        </form>
      ) : null}
      {invitation ? (
        <div
          ref={review}
          tabIndex={-1}
          aria-label="Review machine invitation"
          className="fleet-invitation-review"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !busy) {
              event.preventDefault();
              clear();
            }
          }}
        >
          <h4>Review machine invitation</h4>
          <p className="fleet-wrap">
            Host ID: {invitation.hostId}
            <br />
            Endpoint: {invitation.endpoint}
            <br />
            Expires: {new Date(invitation.expiresAt).toLocaleString()}
          </p>
          {isLoopback(invitation.endpoint) ? (
            <p className="settings-note">
              This is a loopback address. It reaches only the receiving
              computer; use a configured network endpoint to connect another
              machine.
            </p>
          ) : null}
          <div className="form-grid">
            <label className="field">
              <span>Machine ID</span>
              <input
                aria-label="Machine ID"
                value={id}
                disabled={busy}
                onChange={(event) => {
                  setId(event.target.value);
                  setTrusted(false);
                }}
              />
            </label>
            <label className="field">
              <span>Machine name</span>
              <input
                aria-label="Machine name"
                value={label}
                disabled={busy}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
            <label className="field wide">
              <span>Machine description</span>
              <textarea
                aria-label="Machine description"
                rows={3}
                maxLength={4000}
                value={description}
                disabled={busy}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Access</span>
              <Select
                aria-label="Invitation access"
                value={access}
                disabled={busy}
                onValueChange={(value) => {
                  setAccess(value as "read" | "control");
                  setShell(false);
                  setTrusted(false);
                }}
              >
                <option value="read">Read only</option>
                <option
                  value="control"
                  disabled={invitation.access !== "control"}
                >
                  Thread control
                </option>
              </Select>
            </label>
          </div>
          <p className="settings-note">
            Confirm this Host ID directly on the target or through a trusted
            channel. HTTPS certificate checks still apply. Descriptions guide
            the Agent’s use of the machine and cannot grant access. A
            server-issued read grant needs fresh pairing before it can be
            upgraded.
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
              Allow explicit bounded remote shell using the target Thread’s
              existing sandbox and approvals
            </label>
          ) : null}
          <label className="fleet-confirmation">
            <input
              type="checkbox"
              checked={trusted}
              disabled={busy}
              onChange={(event) => setTrusted(event.target.checked)}
            />
            I verified this Host and allow this app to save a revocable{" "}
            {access === "control" ? "Thread control" : "read-only"} connection
            {shell ? " with explicit remote shell" : ""}
          </label>
          <div className="settings-actions fleet-actions">
            <button
              className="primary-button"
              disabled={busy || !trusted}
              onClick={() => void run(pair)}
            >
              {busy ? "Pairing…" : "Pair and check"}
            </button>
            <button className="quiet-button" disabled={busy} onClick={clear}>
              Cancel invitation
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
  const [label, setLabel] = useState("This machine");
  const [confirmed, setConfirmed] = useState(false);
  const [issued, setIssued] = useState<{
    invitation: FleetInvitation;
    serialized: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
        setError(
          "Invitation expired. Create a fresh one when the other user is ready.",
        );
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
            setError(
              "Could not refresh paired clients. Check Fleet status before sharing again.",
            );
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
        label,
        confirmed: true,
        expected,
      });
      if (currentScope.current !== requestedScope) {
        if (mounted.current)
          setError(
            "Fleet Host or sharing scope changed. Refresh, review and confirm before sharing a new invitation.",
          );
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
    <section className="fleet-section-space" aria-label="Invite a client">
      <h4>Invite a client</h4>
      <p>
        Share one invitation through a private, trusted channel. It includes the
        endpoint and Host ID, expires in five minutes, and can be used once.
        Creating another replaces the previous code. Keep it out of Agent
        conversations and logs.
      </p>
      <div className="form-grid">
        <label className="field">
          <span>Invitation endpoint</span>
          <input
            aria-label="Invitation endpoint"
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
          <span>Invitation machine name</span>
          <input
            aria-label="Invitation machine name"
            value={label}
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
        Use the configured client-facing endpoint, the connected relay, or this
        Host’s listener address. DNS, network reachability and trusted TLS must
        already be ready. A loopback listener works only on the same computer.
      </p>
      <label className="fleet-confirmation">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={disabled || busy || hostingDirty || !snapshot.host.enabled}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        I allow one client holding this invitation to request{" "}
        {hosting?.access === "control" ? "Thread control" : "read-only"} access
        {hosting?.shellEnabled ? " and explicitly opt in to remote shell" : ""}
        {hosting?.relayEndpoint ? " through my trusted relay operator" : ""}
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
        {busy ? "Creating…" : "Create invitation"}
      </button>
      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
      {issued ? (
        <div className="fleet-top-space">
          <label className="field">
            <span>Share invitation</span>
            <input
              aria-label="Share invitation"
              type="password"
              autoComplete="off"
              readOnly
              value={issued.serialized}
              onFocus={(event) => event.target.select()}
            />
          </label>
          <p>
            Expires {new Date(issued.invitation.expiresAt).toLocaleString()}.
            Anyone holding this invitation can request access. Hiding it clears
            this screen; the one-use code remains valid until consumed, replaced
            or expired.
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
                      setError(
                        "Clipboard unavailable. Select the invitation field and copy it using the system Copy action.",
                      );
                  },
                );
              }}
            >
              {copied ? "Copied" : "Copy invitation"}
            </button>
            <button
              className="quiet-button"
              onClick={() => {
                setIssued(null);
                setCopied(false);
              }}
            >
              Hide invitation
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
function message(reason: unknown) {
  const value = reason instanceof Error ? reason.message : String(reason);
  return value.replace(
    /^Error invoking remote method 'zenx:fleet:control': (?:Error: )?/u,
    "",
  );
}
