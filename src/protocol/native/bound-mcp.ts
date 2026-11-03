/** Host-injected fixed-owner MCP transport; Core owns no product tools or owners. */
export interface NativeBoundMcpConnection {
  receive(message: unknown): Promise<void>;
  close(): Promise<void>;
}
export type OpenNativeBoundMcp = (options: {
  owner: unknown;
  signal: AbortSignal;
  send(message: unknown): void;
}) => Promise<NativeBoundMcpConnection>;
export const NATIVE_MCP_BIND_METHOD = "zen/mcp/bind";
export const NATIVE_MCP_MESSAGE_METHOD = "zen/mcp/message";
