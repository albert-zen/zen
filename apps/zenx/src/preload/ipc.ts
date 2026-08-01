export const ipcChannels = {
  getStatus: "zenx:app-server:get-status",
  request: "zenx:protocol:request",
  status: "zenx:app-server:status",
  notification: "zenx:protocol:notification",
} as const;
