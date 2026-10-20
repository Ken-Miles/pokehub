import { request } from 'http'
import { env } from '@/lib/env'
import type { SeenPokemon } from '@/lib/registry'

/**
 * Client for the internal .NET save service (PKHeX.Core). Talks HTTP over TCP in
 * dev (SAVE_SERVICE_URL) or over a unix socket in prod (SAVE_SERVICE_SOCKET), so
 * the service can run with no network at all (NFR-04).
 */

export interface ParsedPokemon extends SeenPokemon {
  speciesName: string
  nickname: string
  isEgg: boolean
  isShiny: boolean
}

export interface ParsedSave {
  ok: true
  generation: number
  family: 'RS' | 'E' | 'FRLG'
  trainer: { name: string; tid: number; sid: number }
  playSeconds: number
  pokemon: ParsedPokemon[]
}

export class SaveServiceError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(`save service: ${status} ${code}`)
  }
}

function call<T>(path: string, body?: Uint8Array): Promise<T> {
  const e = env()
  const target = e.SAVE_SERVICE_SOCKET
    ? { socketPath: e.SAVE_SERVICE_SOCKET }
    : (() => {
        const u = new URL(e.SAVE_SERVICE_URL ?? 'http://localhost:5080')
        return { host: u.hostname, port: Number(u.port || 80) }
      })()

  return new Promise((resolve, reject) => {
    const req = request(
      {
        ...target,
        path,
        method: body ? 'POST' : 'GET',
        headers: body ? { 'content-type': 'application/octet-stream', 'content-length': body.length } : {},
        timeout: 10_000,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json: unknown
          try {
            json = JSON.parse(text)
          } catch {
            return reject(new SaveServiceError(res.statusCode ?? 500, 'bad_response'))
          }
          if ((res.statusCode ?? 500) >= 400) {
            return reject(new SaveServiceError(res.statusCode ?? 500, (json as { error?: string }).error ?? 'error'))
          }
          resolve(json as T)
        })
      },
    )
    req.on('timeout', () => req.destroy(new SaveServiceError(504, 'timeout')))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

export const saveService = {
  health: () => call<{ ok: boolean; pkhex: string }>('/health'),
  parse: (bytes: Uint8Array) => call<ParsedSave>('/parse', bytes),
  legality: (bytes: Uint8Array, box: number, slot: number) =>
    call<{ valid: boolean; report: string; fingerprint: string }>(`/legality?box=${box}&slot=${slot}`, bytes),
}
