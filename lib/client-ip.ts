/**
 * The client's IP for rate limits (NFR-05) and auth_events.
 *
 * X-Forwarded-For is written left to right by each proxy, and its first
 * entries come from the client, so only the entries our own proxies added can
 * be trusted. server/main.ts sees every request first: it resolves the address
 * once (socket address + TRUSTED_PROXY_HOPS) and stores it in CLIENT_IP_HEADER,
 * overwriting anything the client sent. Routes read only that header.
 */
export const CLIENT_IP_HEADER = 'x-hub-client-ip'

/**
 * `hops` = proxies in front of the app that append to X-Forwarded-For
 * (0 in dev, 1 behind nginx, 2 behind a CDN + nginx). The client is the
 * address the outermost trusted proxy saw: `hops` steps left of the socket.
 * If the chain is shorter than that, the request skipped a proxy, so the
 * leftmost entry is as close as we can get (still not trusted for more).
 */
export function resolveClientIp(forwardedFor: string | string[] | undefined, socketAddress: string | undefined, hops: number): string {
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : (forwardedFor ?? '')
  const forwarded = header
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const chain = [...forwarded, socketAddress ?? 'unknown']
  const ip = chain[Math.max(0, chain.length - 1 - Math.max(0, Math.floor(hops)))]
  return ip.replace(/^::ffff:/, '')
}

/** Read the address server/main.ts resolved. Works with a fetch Request or Node-style headers. */
export function clientIp(headers: Headers | Record<string, string | string[] | undefined> | undefined): string {
  const value = headers instanceof Headers ? headers.get(CLIENT_IP_HEADER) : headers?.[CLIENT_IP_HEADER]
  return (Array.isArray(value) ? value[0] : value) || 'unknown'
}
