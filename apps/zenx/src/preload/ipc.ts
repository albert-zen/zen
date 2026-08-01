export const ipcChannels = {
  getStatus: "zenx:app-server:get-status",
  getPendingApprovals: "zenx:protocol:get-pending-approvals",
  request: "zenx:protocol:request",
  approvalRequest: "zenx:protocol:approval-request",
  approvalResolved: "zenx:protocol:approval-resolved",
  respondApproval: "zenx:protocol:respond-approval",
  status: "zenx:app-server:status",
  notification: "zenx:protocol:notification",
} as const;
