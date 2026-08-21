import type { ProviderTransport } from "../../../../apps/cli/src/host.js";
import type { ZenXHostConfig } from "./host-messages.js";

type ProxyResolver = (url: string) => Promise<string>;

export async function zenXProviderTransport(
  config: ZenXHostConfig,
  resolveProxy: ProxyResolver,
): Promise<ProviderTransport | undefined> {
  if (config.provider === undefined) {
    throw new Error("Single-provider proxy resolution requires a provider");
  }
  if (config.provider.type === "fake") return undefined;
  const endpoint =
    config.provider.type === "openai-subscription"
      ? "https://chatgpt.com/backend-api/codex/responses"
      : config.provider.baseUrl;
  const directive = await resolveProxy(endpoint);
  const proxy = proxyUrl(directive);
  return proxy === undefined ? undefined : { proxyUrl: proxy };
}

export async function withZenXProviderTransports(
  config: ZenXHostConfig,
  resolveProxy: ProxyResolver,
): Promise<ZenXHostConfig> {
  if (config.providers === undefined) {
    return {
      ...config,
      transport: await zenXProviderTransport(config, resolveProxy),
    };
  }
  return {
    ...config,
    providers: await Promise.all(
      config.providers.map(async (profile) => ({
        ...profile,
        transport:
          profile.provider.type === "fake"
            ? undefined
            : await transportForProvider(profile.provider, resolveProxy),
      })),
    ),
  };
}

async function transportForProvider(
  provider: NonNullable<ZenXHostConfig["provider"]>,
  resolveProxy: ProxyResolver,
): Promise<ProviderTransport | undefined> {
  if (provider.type === "fake") return undefined;
  const endpoint =
    provider.type === "openai-subscription"
      ? "https://chatgpt.com/backend-api/codex/responses"
      : provider.baseUrl;
  const proxy = proxyUrl(await resolveProxy(endpoint));
  return proxy === undefined ? undefined : { proxyUrl: proxy };
}

export function proxyUrl(directives: string): string | undefined {
  let unsupported = false;
  for (const raw of directives.split(";")) {
    const directive = raw.trim();
    if (directive.length === 0) continue;
    if (directive === "DIRECT") return undefined;
    const match = /^(PROXY|HTTP|HTTPS)\s+(.+)$/iu.exec(directive);
    if (match === null) {
      unsupported = true;
      continue;
    }
    const authority = normalizedAuthority(match[2]!);
    const scheme = match[1]!.toUpperCase() === "HTTPS" ? "https" : "http";
    return `${scheme}://${authority}`;
  }
  if (unsupported) {
    throw new Error(
      "System proxy resolver returned only unsupported proxy types",
    );
  }
  if (directives.trim().length > 0) {
    throw new Error("System proxy resolver returned no usable route");
  }
  throw new Error("System proxy resolver returned an empty route");
}

function normalizedAuthority(value: string): string {
  const authority = value.trim();
  const split = authority.lastIndexOf(":");
  if (split <= 0 || split === authority.length - 1) {
    throw new Error("System proxy directive is missing a host or port");
  }
  const hostname = authority.slice(0, split);
  const port = authority.slice(split + 1);
  if (!/^\d+$/u.test(port) || Number(port) < 1 || Number(port) > 65_535) {
    throw new Error("System proxy directive has an invalid port");
  }
  if (/[@/?#]/u.test(hostname)) {
    throw new Error(
      "System proxy directive contains unsupported credentials or URL syntax",
    );
  }
  return hostname.includes(":") && !hostname.startsWith("[")
    ? `[${hostname}]:${port}`
    : `${hostname}:${port}`;
}
