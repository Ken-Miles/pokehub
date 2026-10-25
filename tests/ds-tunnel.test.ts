import { dsMac, tunnelTicket } from '@/lib/ds-tunnel'

// ds-gateway/gateway.py --selftest checks the same vector, so both sides agree on the format.
const SECRET = 'test-secret-test-secret-test-secret!'
const VECTOR =
  'eyJ1IjoidXNlcl8xIiwibSI6IjAyOjQyOjY0OjE5OjRjOjRjIiwiZSI6MTcwMDAwMDA2MH0.' +
  'F1pI2hKpQ6kSrtix3gDAmOWLMBcoFBX6LsS7aVOT8U8'

describe('DS tunnel (FR-38)', () => {
  it('gives each account a stable, locally administered unicast MAC', () => {
    const mac = dsMac('user_1')
    expect(mac).toMatch(/^02(:[0-9a-f]{2}){5}$/)
    expect(dsMac('user_1')).toBe(mac)
    expect(dsMac('user_2')).not.toBe(mac)
  })

  it('signs the ticket the gateway expects', () => {
    expect(tunnelTicket('user_1', SECRET, 1_700_000_000_000)).toBe(VECTOR)
  })

  it('ticket expires a minute after it is issued', () => {
    const body = JSON.parse(Buffer.from(VECTOR.split('.')[0], 'base64url').toString())
    expect(body).toEqual({ u: 'user_1', m: dsMac('user_1'), e: 1_700_000_060 })
  })
})
