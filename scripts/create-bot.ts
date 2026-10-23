/**
 * Create (or refresh) test bot accounts (FR-36, ADR-023): bot<n> with friend code
 * 0000-0000-<n>, friends with every other bot and with any players named by --friend.
 * Bots have no usable password; only the bot host acts as them.
 *
 *   npm run bots:create -- 5 16 --friend alice
 */
import { randomBytes } from 'crypto'
import { prisma } from '../lib/db'
import { botFriendCode } from '../lib/friend-code'
import { hashPassword } from '../lib/password'

try {
  ;(process as unknown as { loadEnvFile: () => void }).loadEnvFile()
} catch {
  /* optional */
}

async function befriend(a: string, b: string) {
  const existing = await prisma.friendship.findFirst({ where: { OR: [{ requesterId: a, addresseeId: b }, { requesterId: b, addresseeId: a }] } })
  if (existing) await prisma.friendship.update({ where: { id: existing.id }, data: { status: 'ACCEPTED', acceptedAt: existing.acceptedAt ?? new Date() } })
  else await prisma.friendship.create({ data: { requesterId: a, addresseeId: b, status: 'ACCEPTED', acceptedAt: new Date() } })
}

async function main() {
  const args = process.argv.slice(2)
  const friends: string[] = []
  const numbers: number[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--friend') friends.push(args[++i]?.toLowerCase() ?? '')
    else numbers.push(Number(args[i]))
  }
  if (!numbers.length) throw new Error('Usage: npm run bots:create -- <n> [<n> …] [--friend <username> …]')

  for (const n of numbers) {
    const username = `bot${n}`
    await prisma.user.upsert({
      where: { username },
      update: { isBot: true },
      create: {
        username,
        email: `${username}@bots.invalid`,
        passwordHash: await hashPassword(randomBytes(32).toString('hex')), // never told to anyone
        friendCode: botFriendCode(n),
        isBot: true,
        emailVerifiedAt: new Date(),
      },
    })
  }

  const bots = await prisma.user.findMany({ where: { isBot: true }, select: { id: true, username: true } })
  const players = await prisma.user.findMany({ where: { username: { in: friends }, isBot: false }, select: { id: true, username: true } })
  const missing = friends.filter((f) => !players.some((p) => p.username === f))
  if (missing.length) throw new Error(`No such player: ${missing.join(', ')}`)
  for (let i = 0; i < bots.length; i++) {
    for (let j = i + 1; j < bots.length; j++) await befriend(bots[i].id, bots[j].id)
    for (const p of players) await befriend(bots[i].id, p.id)
  }
  console.log(`bots: ${bots.map((b) => b.username).join(', ')}`)
}

main()
  .catch((e) => {
    console.error(e.message ?? e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
