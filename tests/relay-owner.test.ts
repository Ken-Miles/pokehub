import { beforeEach, describe, expect, it, vi } from 'vitest'

// Blue/green (deploy/README.md): a colour starting up must only end the link
// sessions it owns, never the live colour's.
const findMany = vi.fn()
vi.mock('@/lib/db', () => ({ prisma: { linkSession: { findMany } } }))

describe('endOrphanedLinks ownership', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('DEPLOY_COLOR', 'blue')
    findMany.mockReset().mockResolvedValue([])
  })

  it('queries only this colour’s sessions and unclaimed ones', async () => {
    const { endOrphanedLinks } = await import('@/lib/link-sessions')
    await endOrphanedLinks()
    const where = findMany.mock.calls[0][0].where
    expect(where.AND[0]).toEqual({ OR: [{ relayOwner: null }, { relayOwner: 'blue' }] })
  })
})
