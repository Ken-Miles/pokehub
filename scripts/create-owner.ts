/**
 * Create (or promote) the OWNER account.
 *
 *   OWNER_USERNAME=owner OWNER_EMAIL=me@example.com OWNER_PASSWORD=… npm run setup:owner
 */
import { prisma } from '../lib/db'
import { newFriendCode } from '../lib/friend-code'
import { hashPassword } from '../lib/password'

try {
  ;(process as unknown as { loadEnvFile: () => void }).loadEnvFile()
} catch {
  /* optional */
}

async function main() {
  const username = (process.env.OWNER_USERNAME || 'owner').toLowerCase()
  const email = (process.env.OWNER_EMAIL || `${username}@example.com`).toLowerCase()
  const password = process.env.OWNER_PASSWORD
  if (!password || password.length < 10) throw new Error('Set OWNER_PASSWORD (10+ characters).')

  const user = await prisma.user.upsert({
    where: { username },
    update: { role: 'OWNER' },
    create: {
      username,
      email,
      passwordHash: await hashPassword(password),
      role: 'OWNER',
      friendCode: newFriendCode(),
      emailVerifiedAt: new Date(),
    },
  })
  console.log(`owner ready: ${user.username}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
