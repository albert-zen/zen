export const DEFAULT_APP_SERVER_HOST = "127.0.0.1";
export const DEFAULT_APP_SERVER_PORT = 3000;

export function readAppServerPort(value: string | undefined): number {
  if (!value) {
    return DEFAULT_APP_SERVER_PORT;
  }

  const port = Number(value);

  if (Number.isInteger(port) && port >= 0 && port <= 65_535) {
    return port;
  }

  throw new Error("ZEN_APP_SERVER_PORT must be an integer from 0 to 65535");
}
