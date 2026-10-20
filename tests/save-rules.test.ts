import { checkImport, checkRestore, checkUpload, type SlotState } from '@/lib/save-rules'

const slot = (over: Partial<SlotState> = {}): SlotState => ({
  id: 'slot1',
  deletedAt: null,
  lockedByTradeId: null,
  currentVersionId: 'v3',
  ...over,
})
const OK_SIZE = 131_072

describe('checkUpload (ADR-006)', () => {
  it('accepts an upload built on the current version', () => {
    expect(checkUpload(slot(), 'v3', OK_SIZE)).toBeNull()
  })
  it('accepts the RTC-footer size', () => {
    expect(checkUpload(slot(), 'v3', 131_088)).toBeNull()
  })
  it('accepts the first upload of a new slot (no parent)', () => {
    expect(checkUpload(slot({ currentVersionId: null }), null, OK_SIZE)).toBeNull()
  })
  it('rejects a stale tab / pre-trade save state with 409', () => {
    expect(checkUpload(slot(), 'v2', OK_SIZE)?.status).toBe(409)
    expect(checkUpload(slot(), null, OK_SIZE)?.status).toBe(409)
  })
  it('rejects uploads while a trade holds the lock', () => {
    expect(checkUpload(slot({ lockedByTradeId: 't1' }), 'v3', OK_SIZE)?.status).toBe(423)
  })
  it('rejects anything that is not a save-sized file (NFR-01)', () => {
    expect(checkUpload(slot(), 'v3', 16 * 1024 * 1024)?.code).toBe('bad_size')
  })
  it('rejects deleted slots', () => {
    expect(checkUpload(slot({ deletedAt: new Date() }), 'v3', OK_SIZE)?.status).toBe(404)
  })
})

describe('checkImport (FR-25)', () => {
  it('only imports into an empty slot', () => {
    expect(checkImport(slot({ currentVersionId: null }), OK_SIZE)).toBeNull()
    expect(checkImport(slot(), OK_SIZE)?.code).toBe('slot_not_empty')
  })
})

describe('checkRestore (ADR-007)', () => {
  it('allows restoring versions made after the last trade', () => {
    expect(checkRestore(slot(), { slotId: 'slot1', seq: 5 }, 4)).toBeNull()
    expect(checkRestore(slot(), { slotId: 'slot1', seq: 4 }, 4)).toBeNull() // the trade result itself
  })
  it('allows anything when the slot has never traded', () => {
    expect(checkRestore(slot(), { slotId: 'slot1', seq: 1 }, null)).toBeNull()
  })
  it('refuses to restore past a trade', () => {
    expect(checkRestore(slot(), { slotId: 'slot1', seq: 3 }, 4)?.code).toBe('before_trade')
  })
  it("refuses another slot's version", () => {
    expect(checkRestore(slot(), { slotId: 'other', seq: 9 }, null)?.status).toBe(404)
  })
})
