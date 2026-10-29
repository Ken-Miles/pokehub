/**
 * The bot host (FR-36, ADR-023): runs test bots against the site.
 *
 *   npm run bots                                  # interactive: type commands, `help` lists them
 *   npm run bots -- trade bot16 2 bot5 1          # one command, then exit
 *
 * Env: BOT_HOST_SECRET (same as the site's), BOT_GAMES_DIR (read-only folder of the
 * operator's own game files — never uploaded), BOT_SITE_URL (default http://localhost:3000).
 */
import { readFileSync, writeFileSync } from 'fs'
import { createInterface } from 'readline'
import { Bot, findGame } from './bot'
import { KEY, type Button } from './core'
import { cableTrade, walkTo, where } from './emerald'
import { Site } from './site'

try {
  ;(process as unknown as { loadEnvFile: () => void }).loadEnvFile()
} catch {
  /* optional */
}

const SECRET = process.env.BOT_HOST_SECRET ?? ''
const GAMES = process.env.BOT_GAMES_DIR ?? ''
const SITE = (process.env.BOT_SITE_URL ?? 'http://localhost:3000').replace(/\/$/, '')

const bots = new Map<string, Bot>()

function bot(name: string): Bot {
  if (!/^bot\d{1,4}$/.test(name ?? '')) throw new Error(`"${name}" isn't a bot name (bot1 … bot9999).`)
  if (!bots.has(name)) bots.set(name, new Bot(name, new Site(SITE, SECRET, name), GAMES))
  return bots.get(name)!
}

async function running(name: string): Promise<Bot> {
  const b = bot(name)
  if (!b.running) await b.start()
  return b
}

async function emerald(name: string): Promise<Bot> {
  const b = await running(name)
  if (!b.gba) throw new Error(`${name} is playing a DS game; walk and where read Emerald's memory.`)
  return b
}

/** Party position as people say it (1–6) → the game's 0–5. */
function party(arg: string): number {
  const n = Number(arg)
  if (!Number.isInteger(n) || n < 1 || n > 6) throw new Error(`Party position ${arg} should be 1–6.`)
  return n - 1
}

const HELP = `
  setup <bot> <code> [save]   new slot for that GBA or DS game (e.g. BPEE, IRBO) from the games folder; import the save if given
  start <bot> [slot#]         boot the bot's slot from its cloud save and go online
  stop <bot>                  upload the save and go offline
  list                        bots and what they're doing
  cable <bot> <friend>        plug a cable into a friend's running game (a bot or a player)
  unplug <bot>
  accept <bot> on|off         answer cable requests and room invites automatically (default on)
  room <bot> [friend…]        turn the wireless adapter on, open a room and invite friends (bots join by themselves)
  invite <bot> <friend>       invite a friend into the bot's wireless room
  leave <bot>                 leave the wireless room (the host closes it)
  trade <botA> <n> <botB> <m> botA offers party n, botB party m: cable, Trade Center, trade, save, leave
  club <bot> <n>              over the cable already plugged in, or in the Trade Center over wireless (a person may be on the other end), trade party n
  press <bot> <button> [frames]   A B SELECT START RIGHT LEFT UP DOWN R L, and X Y on a DS
  touch <bot> <x> <y> [frames]    tap the DS's lower screen (x 0–255, y 0–191)
  walk <bot> <x> <y>          walk on the current map (Emerald)
  where <bot>                 map, position, screen (Emerald)
  screen <bot> [file.png]     save the bot's screen
  sync <bot>                  upload the save now if it changed
  quit`

const commands: Record<string, (...a: string[]) => Promise<void>> = {
  async help() {
    console.log(HELP)
  },

  async setup(name, code, savePath) {
    const b = bot(name)
    const game = findGame(GAMES, code)
    const { slot } = await b.site.json<{ slot: { id: string; slotNumber: number } }>('/api/slots', {
      method: 'POST',
      body: JSON.stringify({ platform: game.platform, code, sha1: game.sha1, origin: savePath ? 'IMPORTED' : 'NEW' }),
    })
    if (savePath) {
      await b.site.raw(`/api/slots/${slot.id}/import`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: readFileSync(savePath) })
    }
    b.log(`slot ${slot.slotNumber} ready for ${code}${savePath ? ' with the imported save' : ''}`)
  },

  async start(name, slot) {
    await bot(name).start(slot ? Number(slot) : undefined)
  },

  async stop(name) {
    await bot(name).stop()
  },

  async list() {
    if (!bots.size) return console.log('  no bots yet')
    for (const b of bots.values()) {
      console.log(`  ${b.name}  ${b.status}`)
    }
  },

  async cable(name, friend) {
    const b = await running(name)
    await b.requestCable(friend)
    b.log(`asked ${friend} to plug in`)
    await b.plugged()
  },

  async unplug(name) {
    await bot(name).unplug()
  },

  async accept(name, on) {
    bot(name).autoAccept = on !== 'off'
  },

  async room(name, ...friends) {
    const b = await running(name)
    await b.openRoom()
    for (const f of friends) {
      if (bots.has(f)) await running(f)
      await b.inviteToRoom(f)
      b.log(`invited ${f}`)
    }
  },

  async invite(name, friend) {
    if (bots.has(friend)) await running(friend)
    await (await running(name)).inviteToRoom(friend)
  },

  async leave(name) {
    await bot(name).leaveRoom()
  },

  async trade(a, n, b, m) {
    const [botA, botB] = [await running(a), await running(b)]
    const [slotA, slotB] = [party(n), party(m)]
    if (!botA.cable || botA.cable.with !== botB.name) {
      await botA.unplug()
      await botB.unplug()
      await botA.requestCable(botB.name)
      await Promise.all([botA.plugged(), botB.plugged()])
    }
    await Promise.all([cableTrade(botA, slotA), cableTrade(botB, slotB)])
    await botA.unplug()
    await Promise.all([botA.uploadSave(), botB.uploadSave()])
    console.log(`  ✓ ${a} party ${n} ⇄ ${b} party ${m}`)
  },

  async club(name, n) {
    const b = await running(name)
    if (!b.cable && !b.air) throw new Error(`${name} has no cable plugged in and no wireless room.`)
    await cableTrade(b, party(n))
    console.log(`  ✓ ${name} traded party ${n} with ${b.cable?.with ?? 'its partner'}`)
  },

  async press(name, button, frames) {
    const key = button?.toUpperCase() as Button
    if (!(key in KEY)) throw new Error(`No button ${button}.`)
    await (await running(name)).press(key, frames ? Number(frames) : 4)
  },

  async touch(name, x, y, frames) {
    if (!Number.isInteger(Number(x)) || !Number.isInteger(Number(y))) throw new Error('touch takes x and y.')
    await (await running(name)).touch(Number(x), Number(y), frames ? Number(frames) : 4)
  },

  async walk(name, x, y) {
    await walkTo(await emerald(name), Number(x), Number(y))
  },

  async where(name) {
    const w = where(await emerald(name))
    console.log(`  map ${w.group}.${w.num}  at ${w.x},${w.y}${w.moving ? ' (moving)' : ''}  callback2 0x${w.callback2.toString(16)}`)
  },

  async screen(name, file) {
    const out = file ?? `${name}.png`
    writeFileSync(out, (await running(name)).emu!.screenshot())
    console.log(`  wrote ${out}`)
  },

  async sync(name) {
    const sent = await (await running(name)).uploadSave()
    if (!sent) console.log('  unchanged')
  },
}

async function run(line: string) {
  const [cmd, ...args] = line.trim().split(/\s+/)
  if (!cmd) return
  const f = commands[cmd]
  if (!f) return console.log(`  unknown command "${cmd}" — try help`)
  try {
    await f(...args)
  } catch (e) {
    console.log(`  ✗ ${(e as Error).message}`)
  }
}

async function shutdown() {
  for (const b of bots.values()) await b.stop()
  process.exit(0)
}

async function main() {
  if (SECRET.length < 32) throw new Error('Set BOT_HOST_SECRET (32+ characters, the same as the site).')
  if (!GAMES) throw new Error('Set BOT_GAMES_DIR to the read-only folder of game files.')
  process.on('SIGINT', () => void shutdown())

  const once = process.argv.slice(2).join(' ')
  if (once) {
    await run(once)
    return shutdown()
  }
  console.log(`bot host → ${SITE}  (help lists commands)`)
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'bots> ' })
  rl.prompt()
  // One command at a time, so output stays readable; `trade` etc. finish before the next prompt.
  for await (const line of rl) {
    if (line.trim() === 'quit') break
    await run(line)
    rl.prompt()
  }
  await shutdown()
}

main().catch((e) => {
  console.error(e.message ?? e)
  process.exit(1)
})
