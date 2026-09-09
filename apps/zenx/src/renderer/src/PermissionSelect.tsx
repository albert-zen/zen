import type { FilePermissionMode } from "../../protocol-client/types.js";
import { Icon } from "./icons.js";

export const permissionLabels: Record<FilePermissionMode, string> = {
  "read-only": "Read only",
  "workspace-write": "Workspace write",
  "danger-full-access": "Full access",
};
export function PermissionSelect({
  value,
  disabled,
  switching,
  error,
  legacyApproval = false,
  onChange,
}: {
  value: FilePermissionMode;
  legacyApproval?: boolean;
  disabled: boolean;
  switching?: boolean;
  error?: string | null;
  onChange?(mode: FilePermissionMode): void;
}) {
  return (
    <div className="permission-picker">
      <label
        className="composer-tool permission-control"
        title={
          disabled
            ? "Wait for the current operation to finish before changing permissions"
            : "Read only: no automatic file changes. Workspace write: changes inside this project. Other tool execution may request one-time approval."
        }
      >
        <Icon name="lock" size={14} />
        <select
          aria-label="File permissions"
          aria-describedby={error ? "composer-permission-error" : undefined}
          value={legacyApproval ? "ask_unknown" : value}
          disabled={disabled || switching || onChange === undefined}
          onChange={(event) =>
            onChange?.(event.target.value as FilePermissionMode)
          }
        >
          {legacyApproval ? (
            <option value="ask_unknown" disabled hidden>
              Approval required
            </option>
          ) : null}
          {Object.entries(permissionLabels).map(([mode, label]) => (
            <option key={mode} value={mode}>
              {label}
            </option>
          ))}
        </select>
        {switching ? <span role="status">Saving…</span> : null}
      </label>
      {error ? (
        <span
          id="composer-permission-error"
          role="alert"
          className="permission-error"
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}
