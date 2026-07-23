export type DesktopAppServerMode =
  | { readonly type: 'private' }
  | {
      readonly type: 'external';
      readonly url: string;
      readonly capability: string;
    };

export function resolveDesktopAppServerMode(
  env: Readonly<Record<string, string | undefined>>
): DesktopAppServerMode {
  const urlValue = env.ZEN_APP_SERVER_URL?.trim();
  const capability = env.ZEN_APP_SERVER_CAPABILITY?.trim();
  if (!urlValue && !capability) return { type: 'private' };
  if (!urlValue || !capability) {
    throw new Error(
      'Set both ZEN_APP_SERVER_URL and ZEN_APP_SERVER_CAPABILITY for external ZenX mode'
    );
  }
  if (
    Buffer.byteLength(capability, 'utf8') < 32 ||
    [...capability].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127;
    })
  ) {
    throw new Error('ZEN_APP_SERVER_CAPABILITY must be at least 32 bytes without whitespace');
  }

  const url = new URL(urlValue);
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'http:' || !loopback || url.username || url.password) {
    throw new Error('ZEN_APP_SERVER_URL must be trusted loopback HTTP without userinfo');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('ZEN_APP_SERVER_URL must be an origin URL without path, query, or fragment');
  }
  return { type: 'external', url: url.href, capability };
}
