/**
 * Hosting cost of the server-relay transport: N simulated link sessions push
 * their traffic through server.ts while we watch its CPU and the latency.
 *
 *   npm run spike:link                       # terminal 1
 *   npm run spike:link:load -- naive 10,50,100
 *   npm run spike:link:load -- lockstep 10,100,500
 *
 * naive    = Approach A, 9 sequential round trips per frame per session
 * lockstep = Approach B, each player sends one input per frame
 *
 * Clients are spread over several processes so the load generator isn't the
 * bottleneck; it still shares the machine with the server.
 */
import { fork } from 'child_process'
import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { cpus } from 'os'
import { io, type Socket } from 'socket.io-client'

const URL = process.env.URL ?? 'http://localhost:3100'
const FRAME_MS = 1000 / 59.7275
type Pattern = 'naive' | 'lockstep'
type ChildResult = { frames: number[]; latencies: number[]; seconds: number }

function connect(room: string): Promise<Socket> {
  return new Promise((resolve) => {
    const s = io(URL, { transports: ['websocket'], forceNew: true })
    s.on('connect', () => {
      s.emit('join', room)
      resolve(s)
    })
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function pct(xs: number[], p: number) {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 100) / 100
}

// ---------- child: runs a share of the sessions ----------
async function child(pattern: Pattern, pairs: number, seconds: number, tag: string) {
  const sessions: [Socket, Socket][] = []
  for (let i = 0; i < pairs; i++) sessions.push([await connect(`${tag}-${i}`), await connect(`${tag}-${i}`)])
  await sleep(300)
  const latencies: number[] = []
  const frames: number[] = []
  const end = performance.now() + seconds * 1000

  await Promise.all(
    sessions.map(async ([a, b], idx) => {
      if (pattern === 'naive') {
        b.on('r', (m: [string, number]) => b.emit('r', ['P', m[1]]))
        const waiters = new Map<number, () => void>()
        a.on('r', (m: [string, number]) => {
          waiters.get(m[1])?.()
          waiters.delete(m[1])
        })
        let seq = 0
        let count = 0
        let next = performance.now() + Math.random() * FRAME_MS
        while (performance.now() < end) {
          for (let k = 0; k < 9; k++) {
            const t0 = performance.now()
            await new Promise<void>((res) => {
              const id = ++seq
              waiters.set(id, res)
              a.emit('r', ['p', id])
            })
            if (k === 0 && idx % 4 === 0) latencies.push(performance.now() - t0)
          }
          count++
          next += FRAME_MS
          const wait = next - performance.now()
          if (wait > 0) await sleep(wait)
          else next = performance.now()
        }
        frames.push(count)
      } else {
        // Both sides send one input per frame; same process, so one-way delay is measurable.
        for (const s of [a, b]) s.on('r', (m: [string, number, number]) => latencies.push(performance.now() - m[2]))
        let count = 0
        let next = performance.now() + Math.random() * FRAME_MS
        while (performance.now() < end) {
          a.emit('r', ['i', count, performance.now()])
          b.emit('r', ['i', count, performance.now()])
          count++
          next += FRAME_MS
          const wait = next - performance.now()
          if (wait > 0) await sleep(wait)
          else next = performance.now()
        }
        frames.push(count)
      }
    }),
  )
  for (const [a, b] of sessions) {
    a.close()
    b.close()
  }
  // Keep the payload small: sample latencies.
  const sample = latencies.filter((_, i) => i % Math.max(1, Math.floor(latencies.length / 20000)) === 0)
  process.send!({ frames, latencies: sample, seconds } satisfies ChildResult, () => process.exit(0))
}

// ---------- parent ----------
async function sampleStats(stop: { done: boolean }) {
  const samples: { cpuPct: number; msgsPerSec: number }[] = []
  await sleep(1500) // skip connection setup
  while (!stop.done) {
    // An overloaded server may not answer in time; count that as a saturated sample.
    try {
      samples.push(await (await fetch(`${URL}/stats`, { signal: AbortSignal.timeout(3000) })).json())
    } catch {
      samples.push({ cpuPct: 100, msgsPerSec: 0 })
    }
    await sleep(1000)
  }
  return samples
}

async function run(pattern: Pattern, pairs: number, seconds: number) {
  const procs = Math.min(pairs, Math.max(1, Math.min(8, cpus().length - 4)))
  const stop = { done: false }
  const statsP = sampleStats(stop)
  const results = await Promise.all(
    Array.from({ length: procs }, (_, p) => {
      const share = Math.floor(pairs / procs) + (p < pairs % procs ? 1 : 0)
      return new Promise<ChildResult>((resolve) => {
        const c = fork(process.argv[1], ['--child', pattern, String(share), String(seconds), `${pattern}-${pairs}-${p}`])
        c.on('message', (m) => resolve(m as ChildResult))
      })
    }),
  )
  stop.done = true
  const stats = await statsP
  const frames = results.flatMap((r) => r.frames)
  const lat = results.flatMap((r) => r.latencies)
  const fps = frames.map((f) => f / seconds)
  const cpu = stats.map((s) => s.cpuPct)
  const msgs = stats.map((s) => s.msgsPerSec)
  return {
    pattern,
    sessions: pairs,
    seconds,
    fpsPerSession: { mean: Math.round((fps.reduce((a, b) => a + b, 0) / fps.length) * 10) / 10, min: Math.round(Math.min(...fps) * 10) / 10 },
    latencyMs: { what: pattern === 'naive' ? 'round trip' : 'one way', p50: pct(lat, 0.5), p95: pct(lat, 0.95), p99: pct(lat, 0.99) },
    server: {
      cpuPctMean: Math.round((cpu.reduce((a, b) => a + b, 0) / Math.max(1, cpu.length)) * 10) / 10,
      cpuPctMax: Math.max(0, ...cpu),
      relayedMsgsPerSecMean: Math.round(msgs.reduce((a, b) => a + b, 0) / Math.max(1, msgs.length)),
    },
  }
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv[0] === '--child') return child(argv[1] as Pattern, Number(argv[2]), Number(argv[3]), argv[4])
  const pattern = (argv[0] ?? 'naive') as Pattern
  const counts = (argv[1] ?? '10,50,100').split(',').map(Number)
  const seconds = Number(argv[2] ?? 15)
  const all = []
  for (const n of counts) {
    const r = await run(pattern, n, seconds)
    console.log(JSON.stringify(r))
    all.push(r)
    await sleep(2000)
  }
  const dir = join(process.cwd(), 'spikes/link-latency/results')
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-load-${pattern}.json`)
  await writeFile(file, JSON.stringify({ url: URL, cpu: cpus()[0].model, at: new Date().toISOString(), runs: all }, null, 2))
  console.log(`saved ${file}`)
}

main()
