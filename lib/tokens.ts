import { createHash, randomBytes } from 'crypto'

/** Random URL-safe token; only its SHA-256 is stored. */
export function newToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, tokenHash: hashToken(token) }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
