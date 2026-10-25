import { createHash, createHmac } from 'crypto'

/** How long a tunnel ticket can be used to open a tunnel; an open tunnel isn't cut when it expires. */
export const TUNNEL_TICKET_SECONDS = 60

/**
 * FR-38/FR-39: the emulated DS's MAC address, stable per site account. Locally
 * administered (02:…) so it never looks like real hardware. The gateway only
 * forwards frames from this MAC, so one account can't pose as another's DS.
 * shortcut: 40 hashed bits can collide (~1 in a million accounts online at once,
 * the gateway refuses the second); store an allocated MAC per user if that matters.
 */
export function dsMac(userId: string): string {
  const h = createHash('sha256').update(`ds-mac:${userId}`).digest()
  return ['02', ...[...h.subarray(0, 5)].map((b) => b.toString(16).padStart(2, '0'))].join(':')
}

/**
 * A short-lived ticket the page hands the DS gateway (ds-gateway/gateway.py checks it):
 * base64url(JSON {u, m, e}) + '.' + base64url(HMAC-SHA256(secret, first part)).
 */
export function tunnelTicket(userId: string, secret: string, nowMs = Date.now()): string {
  const body = Buffer.from(
    JSON.stringify({ u: userId, m: dsMac(userId), e: Math.floor(nowMs / 1000) + TUNNEL_TICKET_SECONDS }),
  ).toString('base64url')
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}
