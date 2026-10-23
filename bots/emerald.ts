import type { Bot } from './bot'
import type { Button } from './core'

/**
 * Pokémon Emerald (US, BPEE, SHA-1 f3ae0881…) steps for a bot (FR-36, ADR-023).
 * Addresses come from pret's pokeemerald symbol file (symbols branch) and are only
 * right for that one build; scripts and layouts from its data/maps and
 * data/scripts/cable_club.inc. Memory addresses only — nothing here is game data.
 *
 * A bot's base save stands in any Pokémon Center 2F, below the right-hand counter
 * (the Cable Club / Direct Corner attendant), with a Pokédex, 2+ party Pokémon and
 * text speed Fast.
 */

export const EMERALD_SHA1 = 'f3ae088181bf583e55daf962a92bb46f4f1d07b7'

const gMain = 0x030022c0 // callback2 at +4
const gSaveBlock1Ptr = 0x03005d8c // -> location.mapGroup +4, location.mapNum +5
const gPlayerAvatar = 0x02037590 // tileTransitionState +3 (0 = standing still), objectEventId +5
const gObjectEvents = 0x02037350 // 0x24 bytes each, currentCoords s16 x,y at +0x10 (map coords + 7)
const gLocalLinkPlayerId = 0x03005db4
const gLinkPlayerObjectEvents = 0x02032308 // 4 bytes each: active +0, objEventId +2
const gPlayerParty = 0x020244ec // 6 × 100 bytes, personality u32 at +0
const sTradeMenu = 0x0203229c // -> cursorPosition +0x35, callbackId +0x6F (src/trade.c)
const CB2_Overworld = 0x08085e5c
const CB2_TradeMenu = 0x0807825c

const TRADE_CENTER = { group: 25, num: 25 }
/** Stand here facing up to talk to the attendant (OldaleTown_PokemonCenter_2F: attendant at 10,2). */
const COUNTER = { x: 10, y: 4 }
/** Trade Center chairs by link player id (coord events EventScript_TradeCenter_Chair0/1). */
const CHAIRS = [{ x: 4, y: 5 }, { x: 7, y: 5 }]
const EXITS = [{ x: 5, y: 8 }, { x: 6, y: 8 }]

// Trade menu callbackIds (src/trade.c).
const MENU_MAIN = 0
const MENU_SELECTED_MON = 1
const MENU_CONFIRM = 3
const MENU_CANCEL_PROMPT = 4
const MENU_TRADE_CANCELED = 8
const MENU_PARTNER_INVALID = 17
const CANCEL = 12 // cursor position of the trade menu's Cancel

const SECOND = 60

const s16 = (v: number) => (v << 16) >> 16

export function where(bot: Bot) {
  const g = bot.gba!
  const sb1 = g.read32(gSaveBlock1Ptr)
  let player = gObjectEvents + g.read8(gPlayerAvatar + 5) * 0x24
  let moving = g.read8(gPlayerAvatar + 3) !== 0
  // Link rooms (Trade Center, Colosseum…) spawn no player avatar (InitObjectEventsLink): each
  // player is a link player object, mid-step while directionSequenceIndex (+0x21) counts down.
  const link = gLinkPlayerObjectEvents + (g.read8(gLocalLinkPlayerId) & 3) * 4
  if (!(g.read8(player + 2) & 1) && g.read8(link)) {
    player = gObjectEvents + g.read8(link + 2) * 0x24
    moving = g.read8(player + 0x21) !== 0
  }
  return {
    group: g.read8(sb1 + 4),
    num: g.read8(sb1 + 5),
    x: s16(g.read16(player + 0x10)) - 7,
    y: s16(g.read16(player + 0x12)) - 7,
    moving,
    callback2: (g.read32(gMain + 4) & ~1) >>> 0,
  }
}

const inOverworld = (bot: Bot) => where(bot).callback2 === CB2_Overworld
const inTradeCenter = (bot: Bot) => {
  const w = where(bot)
  return w.callback2 === CB2_Overworld && w.group === TRADE_CENTER.group && w.num === TRADE_CENTER.num
}

function tradeMenu(bot: Bot) {
  if (where(bot).callback2 !== CB2_TradeMenu) return null
  const menu = bot.gba!.read32(sTradeMenu)
  return menu ? { cursor: bot.gba!.read8(menu + 0x35), state: bot.gba!.read8(menu + 0x6f) } : null
}

const personality = (bot: Bot, slot: number) => bot.gba!.read32(gPlayerParty + slot * 100)

/**
 * Walk to (x, y) on the current map, a tile at a time, vertical first and around
 * anything in the way. Stops early if the map changes (a warp).
 */
export async function walkTo(bot: Bot, x: number, y: number) {
  const start = where(bot)
  for (let steps = 0; steps < 40; steps++) {
    const w = where(bot)
    if (w.group !== start.group || w.num !== start.num) return
    if (w.x === x && w.y === y) return
    const vertical: Button | null = w.y < y ? 'DOWN' : w.y > y ? 'UP' : null
    const horizontal: Button | null = w.x < x ? 'RIGHT' : w.x > x ? 'LEFT' : null
    let moved = false
    for (const dir of [vertical, horizontal]) {
      if (!dir) continue
      if (await step(bot, dir)) {
        moved = true
        break
      }
    }
    if (!moved) throw new Error(`${bot.name}: can't walk from ${w.x},${w.y} towards ${x},${y}`)
  }
  throw new Error(`${bot.name}: never reached ${x},${y}`)
}

/** Hold a direction until the player's tile changes (a tap only turns them), then let the step finish. */
async function step(bot: Bot, dir: Button): Promise<boolean> {
  const before = where(bot)
  for (let f = 0; f < 32; f++) {
    await bot.hold([dir], 1)
    const w = where(bot)
    if (w.x !== before.x || w.y !== before.y || w.group !== before.group || w.num !== before.num) {
      await bot.until(() => !where(bot).moving, SECOND, 'the step to finish')
      return true
    }
  }
  return false
}

async function face(bot: Bot, dir: Button) {
  await bot.hold([dir], 2)
  await bot.wait(8)
}

/** From the 2F, talk to the Cable Club attendant until the link is up and the bot is in the Trade Center. */
export async function enterTradeCenter(bot: Bot) {
  if (inTradeCenter(bot)) return
  await bot.until(() => inOverworld(bot), 10 * SECOND, 'the overworld')
  await walkTo(bot, COUNTER.x, COUNTER.y)
  await face(bot, 'UP')
  // A talks, picks TRADE CENTER (first choice), saves (YES), and dismisses each message.
  // A failed link-up just ends the script, and the next A asks again. Never B: it cancels the link-up.
  for (let f = 0; f < 120 * SECOND && !inTradeCenter(bot); f += 30) {
    await bot.press('A')
    await bot.wait(26)
  }
  if (!inTradeCenter(bot)) throw new Error(`${bot.name}: never got into the Trade Center`)
  bot.log('in the Trade Center')
}

/** Sit in this player's chair; when both are seated the trade menu opens. */
export async function sitDown(bot: Bot) {
  await bot.wait(SECOND)
  const seat = bot.gba!.read8(gLocalLinkPlayerId) & 1
  await walkTo(bot, CHAIRS[seat].x, CHAIRS[seat].y)
  await bot.until(() => tradeMenu(bot) !== null, 120 * SECOND, 'the trade menu (is the partner seated?)')
  bot.log('at the trade menu')
}

/** Move the trade menu's cursor to `target`: own party is 0–5 in two columns, the partner's 6–11, Cancel is 12. */
async function cursorTo(bot: Bot, target: number) {
  for (let tries = 0; tries < 20; tries++) {
    const m = tradeMenu(bot)
    if (!m || m.state !== MENU_MAIN) return false
    if (m.cursor === target) return true
    let dir: Button
    // Cancel is below the partner's right column (6 7 / 8 9 / 10 11); our own columns only wrap (sCursorMoveDestinations).
    if (target === CANCEL) dir = m.cursor < 6 || m.cursor % 2 === 0 ? 'RIGHT' : 'DOWN'
    else if (m.cursor === CANCEL) dir = 'UP'
    else if (m.cursor >= 6) dir = 'LEFT' // on the partner's side
    else if (m.cursor >> 1 !== target >> 1) dir = m.cursor >> 1 < target >> 1 ? 'DOWN' : 'UP'
    else dir = m.cursor < target ? 'RIGHT' : 'LEFT'
    await bot.press(dir)
    await bot.wait(4)
  }
  throw new Error(`${bot.name}: couldn't move the trade cursor to ${target}`)
}

/** Offer party Pokémon `slot` (0-based) and confirm; resolves once the trade is done and saved in-game. */
export async function offer(bot: Bot, slot: number) {
  const before = personality(bot, slot)
  for (let f = 0; f < 300 * SECOND; f += 10) {
    const m = tradeMenu(bot)
    if (m && personality(bot, slot) !== before) {
      // Back at the menu with someone new in that slot: traded, and the game has saved.
      await bot.until(() => tradeMenu(bot)?.state === MENU_MAIN, 30 * SECOND, 'the trade menu after the trade')
      bot.log(`traded party ${slot + 1}`)
      return
    }
    if (m?.state === MENU_MAIN) {
      if (await cursorTo(bot, slot)) await bot.press('A')
    } else if (m?.state === MENU_SELECTED_MON) {
      // SUMMARY / TRADE, no wrap: down twice always lands on TRADE.
      await bot.press('DOWN')
      await bot.press('DOWN')
      await bot.press('A')
    } else if (m?.state === MENU_CONFIRM) {
      await bot.press('A') // YES
    } else if (m?.state === MENU_TRADE_CANCELED || m?.state === MENU_PARTNER_INVALID) {
      throw new Error(`${bot.name}: the game refused the trade (menu state ${m.state})`)
    }
    await bot.wait(10)
  }
  throw new Error(`${bot.name}: the trade never finished`)
}

/** Cancel out of the trade menu (both players must) and walk out of the Trade Center. */
export async function leave(bot: Bot) {
  for (let f = 0; f < 60 * SECOND && tradeMenu(bot); f += 10) {
    const m = tradeMenu(bot)!
    if (m.state === MENU_MAIN) {
      if (await cursorTo(bot, CANCEL)) await bot.press('A')
    } else if (m.state === MENU_CANCEL_PROMPT) {
      await bot.press('A') // YES
    }
    await bot.wait(10)
  }
  await bot.until(() => inTradeCenter(bot), 30 * SECOND, 'the Trade Center after leaving the menu')
  await bot.wait(SECOND)
  const seat = bot.gba!.read8(gLocalLinkPlayerId) & 1
  await walkTo(bot, EXITS[seat].x, EXITS[seat].y - 1)
  await bot.hold(['DOWN'], 20)
  // "The link will be terminated if you leave the room. Is that okay?" YES (EventScript_ConfirmLeaveCableClubRoom).
  for (let f = 0; f < 30 * SECOND && inTradeCenter(bot); f += SECOND) {
    await bot.press('A')
    await bot.wait(SECOND - 8)
  }
  await bot.until(() => !inTradeCenter(bot) && inOverworld(bot), 30 * SECOND, 'the 2F')
  // The attendant's goodbye message.
  for (let i = 0; i < 6; i++) {
    await bot.wait(SECOND)
    await bot.press('A')
  }
  bot.log('back on the 2F')
}

/** The whole cable trade from one side, cable already plugged in. */
export async function cableTrade(bot: Bot, slot: number) {
  if (bot.game?.sha1 !== EMERALD_SHA1) throw new Error(`${bot.name}: these steps are for Emerald (US) ${EMERALD_SHA1.slice(0, 8)}… only.`)
  await enterTradeCenter(bot)
  await sitDown(bot)
  await offer(bot, slot)
  await bot.uploadSave()
  await leave(bot)
}
