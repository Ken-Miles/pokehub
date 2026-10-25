import { createHash, randomInt, timingSafeEqual } from 'crypto'
import { env } from '@/lib/env'

/** The DS's three Wi-Fi access point blocks (emulator/melonds/hub.cpp HUB_WIFI_BYTES). */
export const WIFI_SETTINGS_BYTES = 768

/** Header the DS gateway signs its calls to /api/ds/signin with. */
export const DS_GATEWAY_KEY_HEADER = 'x-ds-gateway-key'

const digest = (s: string) => createHash('sha256').update(s).digest()

export function isDsGateway(req: Request): boolean {
  const secret = env().DS_GATEWAY_SECRET
  const key = req.headers.get(DS_GATEWAY_KEY_HEADER)
  return !!secret && !!key && timingSafeEqual(digest(key), digest(secret))
}

/**
 * A new Nintendo WFC user ID: 13 digits, below 2^43 (the DS keeps 43 bits). We hand these
 * out instead of dwc, whose next ID is max(signed-in IDs) + 1 and so repeats until a DS
 * finishes its first GameSpy login, or after its database is reset.
 */
export function newWfcUserId(): string {
  return String(randomInt(2, 2 ** 43)).padStart(13, '0')
}

export type SigninCheck = { allow: true } | { allow: false; reason: 'not-bound' | 'other-wfc-id' }

/**
 * FR-39: may this account's DS make this sign-in (nas /ac) request? Creating a WFC
 * account is always allowed (the gateway binds the new ID to the account afterwards);
 * everything else must use the ID bound to this account, so a DS can't sign in as
 * someone else's WFC ID by editing its Wi-Fi settings.
 */
export function signinCheck(bound: string | null | undefined, action: string, wfcUserId: string | undefined): SigninCheck {
  if (action.toLowerCase() === 'acctcreate') return { allow: true }
  if (!bound) return { allow: false, reason: 'not-bound' }
  return wfcUserId === bound ? { allow: true } : { allow: false, reason: 'other-wfc-id' }
}
