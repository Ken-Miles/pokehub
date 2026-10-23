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
  /** Left a wireless room that kept running. */
  left?: boolean
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

// ---------------------------------------------------------------- link cable (FR-34, ADR-020, ADR-021)

/**
 * Games that take the network link cable, where each player runs only their own
 * game: Gen 1 and Gen 2 on Game Boy (linked through the Time Capsule), and Gen 3
 * on Game Boy Advance. A cable joins two games of the same platform.
 */
export function cableable(platform: Platform, gameCode: string): boolean {
  const game = identifyGame(platform, gameCode)
  return !!game && game.playable && ((game.platform === 'GB' && game.generation <= 2) || (game.platform === 'GBA' && game.generation === 3))
}

/** Japan and Korea each trade only among themselves; every other language links with the rest. */
const region = (code: string) => (code.at(-1) === 'J' || code.at(-1) === 'K' ? code.at(-1) : 'other')

/**
 * Plug my running game into a friend's. `theirs` is the slot their play page is
 * running right now (null: they aren't playing). Japanese, Korean and international
 * games can't trade (the data differs), so their regions must match.
 */
export function checkCable(
  me: string,
  mine: SlotForSeat,
  friend: { id: string; friends: boolean; blocked: boolean },
  theirs: SlotForSeat | null,
): Rejection | null {
  if (mine.userId !== me || mine.deletedAt) return reject(404, 'not_found', 'Slot not found.')
  if (!cableable(mine.platform, mine.gameCode)) return reject(422, 'not_cable', 'Only Game Boy and Game Boy Advance Pokémon games have a link cable.')
  if (friend.id === me) return reject(409, 'self', "You can't link with yourself.")
  if (!friend.friends || friend.blocked) return reject(403, 'not_friends', 'You can only link with friends.')
  if (!theirs || theirs.userId !== friend.id || theirs.deletedAt || theirs.platform !== mine.platform || !cableable(theirs.platform, theirs.gameCode))
    return reject(409, 'not_playing', "That friend isn't playing a game your cable fits right now.")
  if (region(mine.gameCode) !== region(theirs.gameCode))
    return reject(409, 'language', "Games from different regions (Japan, Korea, the rest) can't link with each other.")
  if (mine.lockedByTradeId || theirs.lockedByTradeId) return reject(423, 'slot_locked', 'A save is locked while a trade finishes.')
  if (mine.otherOpenSessions > 0 || theirs.otherOpenSessions > 0) return reject(409, 'slot_busy', 'One of the games is already linked.')
  return null
}

/** Only the player who was asked can plug the cable in, and only once. */
export function checkAcceptCable(s: SessionState, actorId: string): Rejection | null {
  if (s.mode !== 'CABLE' || !s.seats.some((x) => x.userId === actorId)) return reject(404, 'not_found', 'Link request not found.')
  if (s.state !== 'LOBBY') return reject(409, 'not_in_lobby', 'This link request was already answered.')
  if (s.seats.find((x) => x.seat === 1)?.userId !== actorId) return reject(403, 'not_invitee', 'Only the friend you asked can accept.')
  return null
}

// ---------------------------------------------------------------- wireless rooms (FR-35, ADR-022)

/**
 * Adapters in range of each other (ADR-024). Not the link size: a linked group is
 * a host and at most 4 children, which the emulated adapter enforces as the
 * hardware does, and each game caps its own activities below that.
 */
export const MAX_ROOM = 16

/** Gen 3 games with the Wireless Adapter: FireRed, LeafGreen and Emerald (not Ruby or Sapphire). */
export function airable(platform: Platform, gameCode: string): boolean {
  return cableable(platform, gameCode) && platform === 'GBA' && ['BPE', 'BPR', 'BPG'].includes(gameCode.slice(0, 3))
}

const present = (x: SeatState) => x.ready && !x.left
const pending = (x: SeatState) => !x.ready && !x.left

/** Turn my adapter on: a new room with my running game in seat 0. */
export function checkOpenRoom(me: string, mine: SlotForSeat): Rejection | null {
  if (mine.userId !== me || mine.deletedAt) return reject(404, 'not_found', 'Slot not found.')
  if (!airable(mine.platform, mine.gameCode)) return reject(422, 'not_wireless', 'Only FireRed, LeafGreen and Emerald have the Wireless Adapter.')
  if (mine.lockedByTradeId) return reject(423, 'slot_locked', 'This save is locked while a trade finishes.')
  if (mine.otherOpenSessions > 0) return reject(409, 'slot_busy', 'This game is already linked.')
  return null
}

/** Is this friend's running game one my room could invite? (The online list; `busy` = linked elsewhere.) */
export function checkAirFriend(
  me: string,
  mine: SlotForSeat,
  friend: { id: string; friends: boolean; blocked: boolean },
  theirs: SlotForSeat | null,
): Rejection | null {
  if (friend.id === me) return reject(409, 'self', "You're already in your room.")
  if (!friend.friends || friend.blocked) return reject(403, 'not_friends', 'You can only invite friends.')
  if (!theirs || theirs.userId !== friend.id || theirs.deletedAt || !airable(theirs.platform, theirs.gameCode))
    return reject(409, 'not_playing', "That friend isn't playing FireRed, LeafGreen or Emerald right now.")
  if (region(mine.gameCode) !== region(theirs.gameCode))
    return reject(409, 'language', "Games from different regions (Japan, the rest) can't link with each other.")
  if (theirs.lockedByTradeId) return reject(423, 'slot_locked', "That friend's save is locked while a trade finishes.")
  if (theirs.otherOpenSessions > 0) return reject(409, 'slot_busy', 'That friend is already linked.')
  return null
}

/** Any member may invite an online friend into a running room of at most MAX_ROOM. */
export function checkRoomInvite(
  s: SessionState,
  actorId: string,
  mine: SlotForSeat,
  friend: { id: string; friends: boolean; blocked: boolean },
  theirs: SlotForSeat | null,
): Rejection | null {
  if (s.mode !== 'WIRELESS') return reject(404, 'not_found', 'Room not found.')
  if (!s.seats.some((x) => x.userId === actorId && present(x))) return reject(404, 'not_found', 'Room not found.')
  if (s.state !== 'ACTIVE') return reject(409, 'room_closed', 'This room is closed.')
  if (s.seats.some((x) => x.userId === friend.id && (present(x) || pending(x)))) return reject(409, 'already_invited', 'That friend is already in the room.')
  const problem = checkAirFriend(actorId, mine, friend, theirs)
  if (problem) return problem
  if (s.seats.filter((x) => present(x) || pending(x)).length >= MAX_ROOM) return reject(409, 'full', `A room holds at most ${MAX_ROOM} players.`)
  return null
}

/** The invited friend joins (only once, while the room runs). */
export function checkJoinRoom(s: SessionState, actorId: string): Rejection | null {
  const mine = s.seats.find((x) => x.userId === actorId && !x.left)
  if (s.mode !== 'WIRELESS' || !mine) return reject(404, 'not_found', 'Room invite not found.')
  if (s.state !== 'ACTIVE') return reject(409, 'room_closed', 'This room is closed.')
  if (mine.ready) return reject(409, 'already_joined', "You're already in this room.")
  return null
}

/** A member leaves (or an invitee declines); the host closes the room instead. */
export function checkLeaveRoom(s: SessionState, actorId: string): Rejection | null {
  if (s.mode !== 'WIRELESS' || !s.seats.some((x) => x.userId === actorId && !x.left)) return reject(404, 'not_found', 'Room not found.')
  if (s.state !== 'ACTIVE') return reject(409, 'room_closed', 'This room is closed.')
  if (s.hostId === actorId) return reject(409, 'host', 'Close the room instead.')
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
  if (s.mode === 'WIRELESS' && s.hostId !== actorId) return reject(403, 'not_host', 'Only the host can close the room. Leave it instead.')
  return null
}
