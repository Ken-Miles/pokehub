import { isAdmin, roleAtLeast } from '@/lib/rbac'
import { checkRecover, SLOT_RECOVERY_DAYS } from '@/lib/save-rules'

const now = new Date('2026-10-21T12:00:00Z')
const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 3600 * 1000)

describe('checkRecover (FR-10)', () => {
  it('recovers into the original slot number when it is free', () => {
    expect(checkRecover({ deletedAt: daysAgo(3), slotNumber: 2 }, [1], now)).toEqual({ slotNumber: 2 })
  })
  it('moves to the lowest free number when the original was reused', () => {
    expect(checkRecover({ deletedAt: daysAgo(3), slotNumber: 2 }, [2, 1], now)).toEqual({ slotNumber: 3 })
  })
  it(`works up to ${SLOT_RECOVERY_DAYS} days, not after`, () => {
    expect(checkRecover({ deletedAt: daysAgo(SLOT_RECOVERY_DAYS), slotNumber: 1 }, [], now)).toEqual({ slotNumber: 1 })
    expect(checkRecover({ deletedAt: daysAgo(SLOT_RECOVERY_DAYS + 0.01), slotNumber: 1 }, [], now)).toMatchObject({
      code: 'recovery_expired',
    })
  })
  it('needs room for the slot', () => {
    expect(checkRecover({ deletedAt: daysAgo(1), slotNumber: 1 }, [1, 2, 3], now)).toMatchObject({ code: 'slots_full' })
  })
  it('refuses a slot that is not deleted', () => {
    expect(checkRecover({ deletedAt: null, slotNumber: 1 }, [], now)).toMatchObject({ code: 'not_deleted' })
  })
})

describe('roles', () => {
  it('ranks player < mod < admin < owner', () => {
    expect(roleAtLeast('OWNER', 'ADMIN')).toBe(true)
    expect(roleAtLeast('ADMIN', 'ADMIN')).toBe(true)
    expect(roleAtLeast('MOD', 'ADMIN')).toBe(false)
    expect(roleAtLeast('PLAYER', 'MOD')).toBe(false)
  })
  it('only admins and owners reach /admin; unknown roles get nothing', () => {
    expect(['PLAYER', 'MOD', 'ADMIN', 'OWNER', 'ROOT'].map(isAdmin)).toEqual([false, false, true, true, false])
  })
})
