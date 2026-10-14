import { isRecord } from "../../../src/protocol/codex/wire.js";

/** Text only: authority and remembered scope stay with the Host. */
export function formatApprovalPrompt(params: unknown): string {
  const command =
    isRecord(params) && typeof params.command === "string"
      ? params.command
      : "(unknown command)";
  const toolName =
    isRecord(params) && typeof params.toolName === "string"
      ? params.toolName
      : "tool";
  const target =
    isRecord(params) &&
    isRecord(params.approvalTarget) &&
    typeof params.approvalTarget.label === "string"
      ? params.approvalTarget.label
      : undefined;
  if (target !== undefined) {
    if (isRecord(params) && params.approvalScope === "once") {
      return `\nApprove ${toolName} on ${target}? This decision applies only to this call and its nested operations.\n${command}\n[y]es/[a]pprove once/[n]o/[c]ancel: `;
    }
    return `\nApprove ${toolName} on ${target}? Yes/no is remembered for this tool and target only.\n${command}\n[y]es/[a]pprove once/[n]o/[c]ancel: `;
  }
  const capability =
    toolName === "run_code" ? "shell-equivalent run_code" : toolName;
  return `\nApprove stable ${capability} capability? This decision is remembered by tool name.\n${command}\n[y]es/[a]ll session/[n]o/[c]ancel: `;
}
