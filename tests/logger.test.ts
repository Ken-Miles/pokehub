import pino from 'pino'
import { Writable } from 'stream'
import { logOptions } from '@/lib/logger'

/** NFR-01: save bytes never reach the logs, whatever an error object carries. */
function capture() {
  const lines: string[] = []
  const stream = new Writable({
    write(chunk, _enc, done) {
      lines.push(String(chunk))
      done()
    },
  })
  return { log: pino({ ...logOptions, level: 'debug' }, stream), text: () => lines.join('') }
}

// A recognisable run of bytes, as a save would have.
const marker = Buffer.from('SAVEDATA-0123456789-SAVEDATA')
const save = new Uint8Array(Buffer.concat([Buffer.alloc(64, 0xff), marker, Buffer.alloc(64, 0xff)]))
const leaked = (text: string) =>
  text.includes('SAVEDATA') || text.includes(marker.toString('base64')) || text.includes('"0":255') || text.includes('255,255')

describe('logger (NFR-01)', () => {
  it('drops request input a library attached to an error', () => {
    const { log, text } = capture()
    const err = Object.assign(new Error('PutObject failed'), { code: 'SlowDown', $input: { Body: save, Key: 'saves/x' }, bytes: save })
    log.error({ err }, 'unhandled route error')
    expect(text()).toContain('PutObject failed')
    expect(text()).toContain('SlowDown')
    expect(leaked(text())).toBe(false)
  })

  it('redacts body-like fields wherever they are logged', () => {
    const { log, text } = capture()
    log.info({ body: save, req: { body: save }, upload: { bytes: save, Body: save } }, 'oops')
    expect(text()).toContain('[redacted]')
    expect(leaked(text())).toBe(false)
  })

  it('still logs passwords as redacted, and plain errors in full', () => {
    const { log, text } = capture()
    log.warn({ user: { password: 'hunter2hunter2' }, err: 'not an Error' }, 'x')
    expect(text()).not.toContain('hunter2')
    expect(text()).toContain('not an Error')
  })
})
