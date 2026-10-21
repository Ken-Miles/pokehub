import type { FriendshipStatus } from '@prisma/client'
import type { Rejection } from '@/lib/save-rules'

/**
 * Pure friend-list rules (FR-03), kept free of I/O like lib/save-rules.ts so
 * they are unit-tested (tests/friend-rules.test.ts).
 */

export const MAX_FRIENDS = 200

export interface FriendParty {
  id: string
  emailVerified: boolean
  friendCount: number // accepted friendships
}

export interface Between {
  /** The friendship row between the two, whichever way it was sent. */
  friendship: { requesterId: string; status: FriendshipStatus } | null
  /** Either side blocks the other. */
  blocked: boolean
}

const UNVERIFIED: Rejection = {
  status: 403,
  code: 'email_unverified',
  message: 'Verify your email to add friends.',
}

// Same message whether or not they blocked you, so a block isn't revealed.
const UNAVAILABLE: Rejection = {
  status: 403,
  code: 'unavailable',
  message: "You can't send a friend request to this player.",
}

/**
 * What happens when `me` sends a request to `them`: a new request, accepting
 * theirs (both asked — no reason to make either wait), or a rejection.
 */
export function checkFriendRequest(
  me: FriendParty,
  them: FriendParty,
  between: Between,
): { action: 'request' | 'accept' } | { action: 'reject'; rejection: Rejection } {
  const reject = (rejection: Rejection) => ({ action: 'reject' as const, rejection })
  if (!me.emailVerified) return reject(UNVERIFIED)
  if (me.id === them.id) return reject({ status: 400, code: 'self', message: "You can't add yourself." })
  if (between.blocked) return reject(UNAVAILABLE)

  const f = between.friendship
  if (f?.status === 'ACCEPTED') return reject({ status: 409, code: 'already_friends', message: "You're already friends." })
  if (f && f.requesterId === me.id)
    return reject({ status: 409, code: 'already_requested', message: 'Request already sent.' })

  const theirs = f !== null // pending, sent by them
  const full = checkCapacity(me, them)
  if (full) return reject(full)
  return { action: theirs ? 'accept' : 'request' }
}

/** Accepting a pending request sent to `me` by `them`. */
export function checkAccept(me: FriendParty, them: FriendParty, between: Between): Rejection | null {
  if (!me.emailVerified) return UNVERIFIED
  const f = between.friendship
  if (!f || f.status !== 'PENDING' || f.requesterId !== them.id)
    return { status: 404, code: 'not_found', message: 'Friend request not found.' }
  if (between.blocked) return UNAVAILABLE
  return checkCapacity(me, them)
}

function checkCapacity(me: FriendParty, them: FriendParty): Rejection | null {
  if (me.friendCount >= MAX_FRIENDS)
    return { status: 409, code: 'friends_full', message: `You can have up to ${MAX_FRIENDS} friends.` }
  if (them.friendCount >= MAX_FRIENDS)
    return { status: 409, code: 'friends_full_other', message: 'That player has the most friends allowed.' }
  return null
}
