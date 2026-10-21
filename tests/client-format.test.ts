import { formatPlayTime, formatSyncedAt } from '@/lib/client/api'

describe('slot card text (FR-10)', () => {
  const now = new Date('2026-10-21T12:00:00Z').getTime()
  const ago = (ms: number) => new Date(now - ms).toISOString()
  it('says when the slot last synced', () => {
    expect(formatSyncedAt(ago(20_000), now)).toBe('just now')
    expect(formatSyncedAt(ago(5 * 60_000), now)).toBe('5 min ago')
    expect(formatSyncedAt(ago(3 * 3600_000), now)).toBe('3 h ago')
    expect(formatSyncedAt(ago(3 * 24 * 3600_000), now)).toBe(new Date(now - 3 * 24 * 3600_000).toLocaleDateString())
  })
  it('shows play time as h:mm', () => {
    expect(formatPlayTime(3 * 3600 + 7 * 60 + 59)).toBe('3:07')
  })
})
