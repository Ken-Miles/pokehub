import { CLIENT_IP_HEADER, clientIp, resolveClientIp } from '@/lib/client-ip'

/** NFR-05: rate limits must key on an address the client can't choose. */
describe('resolveClientIp', () => {
  it('with no proxy, uses the socket and ignores X-Forwarded-For entirely', () => {
    expect(resolveClientIp('6.6.6.6', '203.0.113.7', 0)).toBe('203.0.113.7')
    expect(resolveClientIp(undefined, '203.0.113.7', 0)).toBe('203.0.113.7')
  })

  it('behind nginx, takes the address nginx appended, not what the client sent', () => {
    // nginx: X-Forwarded-For = $proxy_add_x_forwarded_for (client's header + $remote_addr)
    expect(resolveClientIp('203.0.113.7', '127.0.0.1', 1)).toBe('203.0.113.7')
    expect(resolveClientIp('6.6.6.6, 203.0.113.7', '127.0.0.1', 1)).toBe('203.0.113.7')
    expect(resolveClientIp('1.1.1.1, 2.2.2.2, 203.0.113.7', '127.0.0.1', 1)).toBe('203.0.113.7')
  })

  it('behind a CDN and nginx, skips both', () => {
    expect(resolveClientIp('6.6.6.6, 203.0.113.7, 198.51.100.1', '127.0.0.1', 2)).toBe('203.0.113.7')
  })

  it('a request that bypassed the proxy gets the leftmost address, never undefined', () => {
    expect(resolveClientIp(undefined, '203.0.113.7', 1)).toBe('203.0.113.7')
    expect(resolveClientIp(undefined, undefined, 1)).toBe('unknown')
  })

  it('accepts repeated headers and strips IPv4-mapped IPv6', () => {
    expect(resolveClientIp(['6.6.6.6', '203.0.113.7'], '::ffff:127.0.0.1', 1)).toBe('203.0.113.7')
    expect(resolveClientIp(undefined, '::ffff:203.0.113.7', 0)).toBe('203.0.113.7')
    expect(resolveClientIp(undefined, '2001:db8::1', 0)).toBe('2001:db8::1')
  })
})

describe('clientIp', () => {
  it('reads only the header server/main.ts sets', () => {
    expect(clientIp(new Headers({ [CLIENT_IP_HEADER]: '203.0.113.7', 'x-forwarded-for': '6.6.6.6' }))).toBe('203.0.113.7')
    expect(clientIp({ [CLIENT_IP_HEADER]: '203.0.113.7', 'x-real-ip': '6.6.6.6' })).toBe('203.0.113.7')
    expect(clientIp(new Headers({ 'x-forwarded-for': '6.6.6.6' }))).toBe('unknown')
    expect(clientIp(undefined)).toBe('unknown')
  })
})
