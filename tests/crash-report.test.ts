import { crashReport } from '@/lib/crash-report'

describe('crash report', () => {
  const ok = { where: 'solo', id: 'slot1', message: 'RuntimeError: unreachable', crashed: true, frames: 1200, recent: ['[wireless adapter] …'] }

  it('accepts a crash from the player', () => {
    expect(crashReport.safeParse(ok).success).toBe(true)
  })

  it('rejects oversized fields', () => {
    expect(crashReport.safeParse({ ...ok, message: 'x'.repeat(1001) }).success).toBe(false)
    expect(crashReport.safeParse({ ...ok, recent: Array(21).fill('x') }).success).toBe(false)
  })
})
