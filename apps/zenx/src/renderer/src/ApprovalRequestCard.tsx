import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ApprovalDecision } from "../../main/app-server-manager.js";
import type { ApprovalCardState } from "./approval-state.js";
import { i18n } from "./i18n.js";
import { Icon } from "./icons.js";
import { Dialog } from "./ui/controls.js";

/** Presentation for the native approval request; it never invents a scope. */
export function ApprovalRequestCard({
  composerId,
  threadId,
  approval,
  onRespond,
}: {
  composerId: string;
  threadId: string;
  approval: ApprovalCardState;
  onRespond(requestId: string, decision: ApprovalDecision): Promise<void>;
}) {
  useTranslation(["shell", "panels"]);
  const titleId = useId();
  const scopeId = useId();
  const identity = `${threadId}\u0000${approval.requestId}`;
  const owner = useRef({ identity, mounted: true, locked: false });
  // Invalidate older promises synchronously, before effects run on a new request.
  if (owner.current.identity !== identity)
    owner.current = { identity, mounted: true, locked: false };
  const currentOwner = owner.current;
  const detailsOwner = useRef<typeof currentOwner | null>(null);
  const [detailsIdentity, setDetailsIdentity] = useState<string | null>(null);
  const [submission, setSubmission] = useState<string | null>(null);
  const [error, setError] = useState<{
    identity: string;
    message: string;
  } | null>(null);
  const succeeded = useRef<string | null>(null);
  useEffect(() => {
    currentOwner.mounted = true;
    return () => {
      currentOwner.mounted = false;
    };
  }, [currentOwner]);

  const once = approval.params.approvalScope === "once";
  const toolName = approval.params.toolName ?? "tool";
  const runCode = toolName === "run_code";
  const code =
    runCode && typeof approval.params.toolArguments?.code === "string"
      ? approval.params.toolArguments.code
      : approval.params.command;
  const title = once
    ? i18n.t("shell:allowToolOnce", { tool: toolName })
    : runCode
      ? i18n.t("shell:allowRunCodeCapability")
      : i18n.t("shell:allowToolCapability", { tool: toolName });
  const question = once
    ? i18n.t("shell:approvalQuestionOnce")
    : i18n.t("shell:approvalQuestionCapability");
  const explanation = once
    ? i18n.t(
        "shell:thisCallRunsOutsideTheFileSandboxApprovalAppliesOnlyToThisCallAndItsNestedOperations",
      )
    : i18n.t("shell:approvalRemembered", { tool: toolName });
  const scopeLabel = once
    ? i18n.t("shell:approvalOnceScope")
    : i18n.t("shell:approvalCapabilityScope");
  const pending = submission === identity || approval.status === "responding";
  const errorMessage = error?.identity === identity ? error.message : null;
  const current = () =>
    currentOwner.mounted &&
    owner.current === currentOwner &&
    approval.params.threadId === threadId;

  const respond = async (decision: "accept" | "decline") => {
    if (!current() || currentOwner.locked || pending) return;
    // The ref closes the same-tick double-click gap across both presentations.
    currentOwner.locked = true;
    setSubmission(identity);
    setError(null);
    try {
      await onRespond(approval.requestId, decision);
      if (!current()) return;
      succeeded.current = identity;
      setDetailsIdentity(null);
      // Keep the lock until the canonical request resolves. The response owner
      // restores Composer focus only if this thread/request still owns it.
    } catch (reason) {
      if (!current()) return;
      currentOwner.locked = false;
      setSubmission(null);
      setError({
        identity,
        message: reason instanceof Error ? reason.message : String(reason),
      });
    }
  };

  const decisions = (surface: "card" | "dialog") => (
    <div className="approval-request-decisions" data-surface={surface}>
      <span className="approval-request-progress" role="status">
        {pending ? i18n.t("shell:approvalResponding") : null}
      </span>
      <button
        className="approval-request-deny"
        type="button"
        disabled={pending}
        onClick={() => void respond("decline")}
      >
        {i18n.t("shell:deny")}
      </button>
      <button
        className="approval-request-allow"
        type="button"
        disabled={pending}
        onClick={() => void respond("accept")}
      >
        <Icon name="check" size={15} />
        {once ? i18n.t("shell:allowOnce") : i18n.t("shell:approvalAllowAccess")}
      </button>
    </div>
  );
  const scope = (id?: string, compact = false) =>
    compact ? (
      <div
        className="approval-request-scope is-compact"
        id={id}
        aria-label={i18n.t("shell:approvalScopeLabel")}
      >
        <Icon name="lock" size={13} />
        <p>
          {once
            ? i18n.t("shell:approvalInlineOnceScope")
            : runCode
              ? i18n.t("shell:approvalInlineRunCodeScope")
              : i18n.t("shell:approvalInlineCapabilityScope", {
                  tool: toolName,
                })}
        </p>
      </div>
    ) : (
      <div className="approval-request-scope" id={id}>
        <div className="approval-request-scope-label">
          <Icon name="lock" size={13} />
          <span>{i18n.t("shell:approvalScopeLabel")}</span>
          <strong>{scopeLabel}</strong>
        </div>
        <p>{explanation}</p>
      </div>
    );
  const cwd = () => (
    <div className="approval-request-cwd">
      <span>{i18n.t("shell:workingDirectory")}</span>
      <code>{approval.params.cwd}</code>
    </div>
  );
  const previewLabel = runCode
    ? i18n.t("shell:approvalCodeLabel")
    : i18n.t("shell:approvalCommandLabel");

  return (
    <>
      <section
        className="approval-request-card"
        data-request-id={approval.requestId}
        data-approval-request={approval.requestId}
        data-approval-thread={threadId}
        data-thread-id={threadId}
        aria-labelledby={titleId}
        aria-describedby={scopeId}
        aria-busy={pending}
        aria-controls={composerId}
      >
        <header className="approval-request-heading">
          <span className="approval-request-icon" aria-hidden="true">
            <Icon name="lock" size={16} />
          </span>
          <h3 id={titleId}>{question}</h3>
          <button
            type="button"
            className="approval-request-details"
            title={i18n.t("shell:approvalRequestDetails")}
            aria-haspopup="dialog"
            onClick={() => {
              detailsOwner.current = currentOwner;
              setDetailsIdentity(identity);
            }}
          >
            <Icon name="expand" size={14} />
            <span>{i18n.t("shell:approvalRequestDetails")}</span>
          </button>
        </header>
        <div className="approval-request-body" tabIndex={0}>
          <div className="approval-request-preview">
            <div className="approval-request-preview-label">
              <Icon name="terminal" size={13} />
              <span>{toolName}</span>
              <span>{previewLabel}</span>
            </div>
            <pre tabIndex={0} aria-label={previewLabel}>
              <code>{code}</code>
            </pre>
          </div>
          {cwd()}
          {scope(scopeId, true)}
          {errorMessage ? (
            <p className="approval-request-error" role="alert">
              {errorMessage}
            </p>
          ) : null}
        </div>
        {decisions("card")}
      </section>
      <Dialog
        open={detailsIdentity === identity}
        onOpenChange={(open) => {
          if (open) detailsOwner.current = currentOwner;
          setDetailsIdentity(open ? identity : null);
        }}
        title={i18n.t("shell:approvalFullRequestTitle")}
        className="approval-request-dialog"
        data-approval-request={approval.requestId}
        data-approval-thread={threadId}
        restoreFocus={() =>
          detailsOwner.current === currentOwner &&
          current() &&
          succeeded.current !== identity
        }
      >
        <header className="approval-request-dialog-heading">
          <div>
            <p>{i18n.t("shell:approvalFullRequestTitle")}</p>
            <h2>{title}</h2>
          </div>
          <button
            className="approval-request-close"
            type="button"
            aria-label={i18n.t("panels:close")}
            title={i18n.t("panels:close")}
            onClick={() => setDetailsIdentity(null)}
          >
            <Icon name="x" size={18} />
          </button>
        </header>
        <div className="approval-request-dialog-body">
          <dl className="approval-request-metadata">
            <div>
              <dt>{i18n.t("shell:approvalToolLabel")}</dt>
              <dd>{toolName}</dd>
            </div>
            <div>
              <dt>{i18n.t("shell:approvalRequestIdLabel")}</dt>
              <dd>
                <code>{approval.requestId}</code>
              </dd>
            </div>
          </dl>
          <div className="approval-request-full-code">
            <h3>{previewLabel}</h3>
            <pre tabIndex={0} aria-label={previewLabel}>
              <code>{code}</code>
            </pre>
          </div>
          {cwd()}
          {approval.params.toolArguments ? (
            <details className="approval-request-arguments">
              <summary>{i18n.t("shell:approvalArgumentsLabel")}</summary>
              <pre tabIndex={0}>
                <code>
                  {JSON.stringify(approval.params.toolArguments, null, 2)}
                </code>
              </pre>
            </details>
          ) : null}
          <details className="approval-request-arguments">
            <summary>{i18n.t("shell:technicalDetails")}</summary>
            <pre tabIndex={0}>
              <code>
                {JSON.stringify(
                  { requestId: approval.requestId, params: approval.params },
                  null,
                  2,
                )}
              </code>
            </pre>
          </details>
        </div>
        <footer className="approval-request-dialog-footer" aria-busy={pending}>
          {scope()}
          {errorMessage ? (
            <p className="approval-request-error" role="alert">
              {errorMessage}
            </p>
          ) : null}
          {decisions("dialog")}
        </footer>
      </Dialog>
    </>
  );
}
