import { io, type Socket } from 'socket.io-client'

/**
 * The site, as one bot sees it (ADR-023): the same API routes and Socket.IO relay a
 * browser uses, authenticated with the bot host's key instead of a session cookie.
 * Never sends a game file: only platform, header code and SHA-1 (as the play page does).
 */
export class Site {
  constructor(
    readonly url: string,
    private readonly key: string,
    readonly bot: string,
  ) {}

  private headers(extra?: Record<string, string>) {
    return { 'x-bot-key': this.key, 'x-bot': this.bot, ...extra }
  }

  async raw(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(this.url + path, { ...init, headers: this.headers(init.headers as Record<string, string>) })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${body.message ?? body.error ?? res.statusText}`)
    }
    return res
  }

  async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const body = init.body
    const res = await this.raw(path, typeof body === 'string' ? { ...init, headers: { 'content-type': 'application/json' } } : init)
    return res.status === 204 ? (undefined as T) : res.json()
  }

  socket(): Socket {
    return io(this.url, { path: '/socket.io', transports: ['websocket'], auth: { botKey: this.key, bot: this.bot } })
  }

  /** Median of five round trips to the site, as the play page measures it (lib/client/api.ts#siteRoundTrip). */
  async roundTrip(): Promise<number> {
    const times: number[] = []
    for (let i = 0; i < 5; i++) {
      const t = performance.now()
      await fetch(this.url + '/emulator/core/build.json', { cache: 'no-store' })
      times.push(performance.now() - t)
    }
    return times.sort((a, b) => a - b)[2]
  }
}
