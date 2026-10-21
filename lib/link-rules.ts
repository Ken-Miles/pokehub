import type { LinkMode, LinkState } from '@prisma/client'
import { identifyGame, type Platform } from '@/lib/games'
import type { Rejection } from '@/lib/save-rules'

/**
 * Pure link-session rules (FR-26, ADR-012), free of I/O like lib/friend-rules.ts
 * so they are unit-tested (tests/link-rules.test.ts). lib/link-sessions.ts
 * loads the state and applies the outcome.
 */

export const MAX_SEATS = 4
/** A lobby nobody starts is closed after this long. */
export const LOBBY_TTL_MS = 2 * 60 * 60 * 1000
/**
 * After a session ends, its seats' closing saves still count as part of it for
 * this long (lib/registry.ts link claims). Every browser flushes on the way out,
 * so a few minutes is plenty; longer would widen the window for replaying a save.
 */
export const LINK_GRACE_MS = 10 * 60 * 1000

export interface SessionState {
  id: string
  hostId: string
  mode: LinkMode
  state: LinkState
  seats: SeatState[]
}

export interface SeatState {
  seat: number
  userId: string
  slotId: string | null
  romSha1: string | null
  coreBuild: string | null
  ready: boolean
}

export interface SlotForSeat {
  id: string
  userId: string
  platform: Platform
  gameCode: string
  deletedAt: Date | null
  lockedByTradeId: string | null
  /** Seats this slot holds in other lobbies or running sessions. */
  otherOpenSessions: number
}

const reject = (status: Rejection['status'], code: string, message: string): Rejection => ({ status, code, message })

const NOT_LOBBY = reject(409, 'not_in_lobby', 'This link session has already started or ended.')

export function seatOf(s: SessionState, seat: number): SeatState | undefined {
  return s.seats.find((x) => x.seat === seat)
}

export function nextSeat(s: SessionState): number | null {
  for (let i = 0; i < MAX_SEATS; i++) if (!seatOf(s, i)) return i
  return null
}

/** NETWORK: the host invites a friend to a free seat. */
export function checkInvite(
  s: SessionState,
  actorId: string,
  invitee: { id: string; friends: boolean; blocked: boolean },
): Rejection | null {
  if (s.state !== 'LOBBY') return NOT_LOBBY
  if (s.hostId !== actorId) return reject(403, 'not_host', 'Only the host can invite players.')
  if (s.mode !== 'NETWORK') return reject(409, 'same_device', 'Add your own games to a same-device session instead.')
  if (invitee.id === actorId) return reject(409, 'self', 'You are already in this session.')
  if (!invitee.friends || invitee.blocked) return reject(403, 'not_friends', 'You can only invite friends.')
  if (s.seats.some((x) => x.userId === invitee.id)) return reject(409, 'already_invited', 'That player is already in this session.')
  if (nextSeat(s) === null) return reject(409, 'full', `A link cable joins at most ${MAX_SEATS} games.`)
  return null
}

/** SAME_DEVICE: the host adds another of their own slots as the next seat. */
export function checkAddOwnSeat(s: SessionState, actorId: string): Rejection | null {
  if (s.state !== 'LOBBY') return NOT_LOBBY
  if (s.hostId !== actorId) return reject(403, 'not_host', 'Only the host can add games.')
  if (s.mode !== 'SAME_DEVICE') return reject(409, 'network', 'Invite friends to a network session instead.')
  if (nextSeat(s) === null) return reject(409, 'full', `A link cable joins at most ${MAX_SEATS} games.`)
  return null
}

/** The games a seat may bring: Gen 3 GBA games all link with each other (FR-15 applies in-game). */
export function linkable(platform: Platform, gameCode: string): boolean {
  const game = identifyGame(platform, gameCode)
  return !!game && game.playable && game.platform === 'GBA' && game.generation === 3
}

/** A player puts one of their slots in their seat. */
export function checkPickSlot(s: SessionState, actorId: string, seat: number, slot: SlotForSeat): Rejection | null {
  if (s.state !== 'LOBBY') return NOT_LOBBY
  const mine = seatOf(s, seat)
  if (!mine || mine.userId !== actorId) return reject(403, 'not_your_seat', "That isn't your seat.")
  if (slot.userId !== actorId || slot.deletedAt) return reject(404, 'not_found', 'Slot not found.')
  if (!linkable(slot.platform, slot.gameCode)) return reject(422, 'not_linkable', 'Only Game Boy Advance Pokémon games can be linked.')
  if (slot.lockedByTradeId) return reject(423, 'slot_locked', 'This save is locked while a trade finishes.')
  if (s.seats.some((x) => x.seat !== seat && x.slotId === slot.id)) return reject(409, 'slot_taken', 'That game is already in this session.')
  if (slot.otherOpenSessions > 0) return reject(409, 'slot_busy', 'That game is already in another link session.')
  return null
}

/**
 * The host starts the cable. Every seat needs a slot and its player's
 * "ready" (game file hashed and checked, emulator build reported), and every
 * browser must run the same emulator build or lockstep can't hold.
 */
export function checkStart(s: SessionState, actorId: string): Rejection | null {
  if (s.state !== 'LOBBY') return NOT_LOBBY
  if (s.hostId !== actorId) return reject(403, 'not_host', 'Only the host can start the session.')
  if (s.seats.length < 2) return reject(409, 'alone', 'A link needs at least two games.')
  if (s.seats.some((x) => !x.slotId)) return reject(409, 'seat_empty', 'Every player needs to choose a game first.')
  if (s.seats.some((x) => !x.ready || !x.romSha1)) return reject(409, 'not_ready', 'Waiting for every player to load their game.')
  const builds = new Set(s.seats.map((x) => x.coreBuild))
  if (builds.size !== 1 || builds.has(null))
    return reject(409, 'build_mismatch', 'Players are on different emulator versions. Everyone needs to reload the page.')
  return null
}

/** A participant may read the saves every browser boots from — only while the session runs. */
export function checkReadSeatSave(s: SessionState, actorId: string): Rejection | null {
  if (!s.seats.some((x) => x.userId === actorId)) return reject(404, 'not_found', 'Link session not found.')
  if (s.state !== 'ACTIVE') return reject(409, 'not_active', 'This link session is not running.')
  return null
}

export type EndReason = 'ended' | 'left' | 'disconnected' | 'desync' | 'expired'

/** Anyone in the session may end it (leaving ends it for all: the cable is cut). */
export function checkEnd(s: SessionState, actorId: string): Rejection | null {
  if (!s.seats.some((x) => x.userId === actorId) && s.hostId !== actorId) return reject(404, 'not_found', 'Link session not found.')
  if (s.state === 'ENDED') return reject(409, 'ended', 'This link session has already ended.')
  return null
}
