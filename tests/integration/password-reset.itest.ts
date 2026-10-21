import { prisma } from '@/lib/db'
import { newFriendCode } from '@/lib/friend-code'
import { hashPassword, verifyPassword } from '@/lib/password'
import { redis } from '@/lib/redis'

/**
 * FR-01 emailed links end to end: reset request → link → new password, and
 * email verification. The mailer is replaced so the test can read the links.
 */
const sent: { to: string; text: string }[] = []
vi.mock('@/lib/mailer', () => ({
  sendMail: async (to: string, _subject: string, text: string) => {
    sent.push({ to, text })
  },
}))

const { POST: requestReset } = await import('@/app/api/auth/reset/route')
const { POST: confirmReset } = await import('@/app/api/auth/reset/confirm/route')
const { GET: verify } = await import('@/app/api/auth/verify/route')
const { sendVerificationEmail } = await import('@/lib/email-tokens')

const run = Date.now().toString(36)
let n = 0

async function user() {
  const tag = `${run}_${n++}`
  return prisma.user.create({
    data: {
      username: `it_${tag}`,
      email: `it-${tag}@example.test`,
      passwordHash: await hashPassword('old-password-1'),
      friendCode: newFriendCode(),
    },
  })
}

const post = (body: unknown, ip = `it-${run}-${n}`) =>
  new Request('http://localhost/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  })

const linkToken = (to: string) => {
  const mail = sent.filter((m) => m.to === to).at(-1)
  return mail?.text.match(/token=([\w-]+)/)?.[1] ?? ''
}

beforeEach(async () => {
  if (!process.env.DATABASE_URL?.includes('/pokehub_test')) throw new Error('refusing to wipe a non-test database')
  await prisma.$executeRawUnsafe('TRUNCATE TABLE users, pokemon_registry, audit_events CASCADE')
  sent.length = 0
})
afterAll(async () => {
  await prisma.$disconnect()
  redis().disconnect()
})

describe('password reset', () => {
  it('sets the new password, signs out every session, and verifies the email', async () => {
    const u = await user()
    expect((await requestReset(post({ email: u.email.toUpperCase() }))).status).toBe(204)
    const token = linkToken(u.email)
    expect(token).not.toBe('')

    expect((await confirmReset(post({ token, password: 'new-password-1' }))).status).toBe(204)
    const after = await prisma.user.findUniqueOrThrow({ where: { id: u.id } })
    expect(await verifyPassword(after.passwordHash, 'new-password-1')).toBe(true)
    expect(after.tokenVersion).toBe(u.tokenVersion + 1)
    expect(after.emailVerifiedAt).not.toBeNull()
    expect(await prisma.authEvent.count({ where: { userId: u.id, event: 'password_reset' } })).toBe(1)
  })

  it('is single-use', async () => {
    const u = await user()
    await requestReset(post({ email: u.email }))
    const token = linkToken(u.email)
    await confirmReset(post({ token, password: 'new-password-1' }))
    const again = await confirmReset(post({ token, password: 'new-password-2' }))
    expect(again.status).toBe(400)
    expect((await again.json()).error).toBe('token_used')
  })

  it('only the newest link works', async () => {
    const u = await user()
    await requestReset(post({ email: u.email }))
    const first = linkToken(u.email)
    await requestReset(post({ email: u.email }))
    expect((await (await confirmReset(post({ token: first, password: 'new-password-1' }))).json()).error).toBe('token_used')
    expect((await confirmReset(post({ token: linkToken(u.email), password: 'new-password-1' }))).status).toBe(204)
  })

  it('expires after an hour', async () => {
    const u = await user()
    await requestReset(post({ email: u.email }))
    await prisma.emailToken.updateMany({ where: { userId: u.id }, data: { expiresAt: new Date(Date.now() - 1) } })
    const res = await confirmReset(post({ token: linkToken(u.email), password: 'new-password-1' }))
    expect((await res.json()).error).toBe('token_expired')
  })

  it("answers the same for an unknown email and sends nothing", async () => {
    expect((await requestReset(post({ email: `nobody-${run}@example.test` }))).status).toBe(204)
    expect(sent).toHaveLength(0)
  })

  it('rejects a short new password', async () => {
    const u = await user()
    await requestReset(post({ email: u.email }))
    expect((await confirmReset(post({ token: linkToken(u.email), password: 'short' }))).status).toBe(400)
  })
})

describe('email verification', () => {
  it('verifies once; a second click is refused', async () => {
    const u = await user()
    await sendVerificationEmail(u.id, u.email)
    const url = `http://localhost/api/auth/verify?token=${linkToken(u.email)}`

    expect((await verify(new Request(url))).headers.get('location')).toContain('verified=1')
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).emailVerifiedAt).not.toBeNull()
    expect((await verify(new Request(url))).headers.get('location')).toContain('verified=0')
  })

  it('a resent link replaces the old one', async () => {
    const u = await user()
    await sendVerificationEmail(u.id, u.email)
    const old = linkToken(u.email)
    await sendVerificationEmail(u.id, u.email)
    expect((await verify(new Request(`http://localhost/x?token=${old}`))).headers.get('location')).toContain('verified=0')
    expect((await verify(new Request(`http://localhost/x?token=${linkToken(u.email)}`))).headers.get('location')).toContain(
      'verified=1',
    )
  })
})
