/**
 * WebRTC data channels between the browsers of a lockstep session (ADR-012).
 * Inputs and hashes go straight to every peer whose channel is open, and also
 * through the Socket.IO relay whenever any peer's isn't — so two laptops on one
 * network (or one cable) talk directly, and everyone else still gets the relay.
 *
 * Signalling rides the relay's `link:signal`, which stamps each message with
 * the sender's seats; a channel only accepts inputs for its peer's own seats,
 * the same rule the relay enforces (`lib/link-relay.ts#relayable`).
 * Framework-free and unit-tested (tests/peer-link.test.ts).
 */

export interface LinkMsg {
  t: 'i' | 'h'
  p: number
  f: number
  k?: number
  h?: number
}

export interface Signal {
  from: string
  to?: string
  hello?: true
  sdp?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
}

interface Peer {
  pc: RTCPeerConnection
  seats: number[]
  dc?: RTCDataChannel
  described: boolean
  candidates: RTCIceCandidateInit[]
}

/** Our last inputs, re-sent through the relay when a channel drops (a peer is never more than a few frames behind). */
const RESEND = 120

// shortcut: host candidates only (same network or cable); add STUN/TURN here when peers come from different networks.
const newConnection = () => new RTCPeerConnection({ iceServers: [] })

export class PeerLinks {
  readonly id = crypto.randomUUID()
  private readonly peers = new Map<string, Peer>()
  private readonly recent: LinkMsg[] = []

  constructor(
    /** Other browsers in the session; below this many open channels, everything also goes through the relay. */
    private readonly expected: number,
    private readonly signal: (s: Signal) => void,
    private readonly relay: (m: LinkMsg) => void,
    private readonly receive: (m: LinkMsg) => void,
    private readonly connect: () => RTCPeerConnection = newConnection,
  ) {}

  /** Announce this browser once it has joined the relay; whoever has the lower id makes the offer. */
  hello(): void {
    this.signal({ from: this.id, hello: true })
  }

  /** Every channel open: the relay isn't needed for our messages. */
  get direct(): boolean {
    return this.open() >= this.expected
  }

  async onSignal(data: unknown, seats: number[]): Promise<void> {
    const s = data as Signal | null
    if (!s || typeof s.from !== 'string' || s.from === this.id || (s.to !== undefined && s.to !== this.id)) return
    let peer = this.peers.get(s.from)
    if (s.hello) {
      if (peer) return
      if (this.id < s.from) {
        peer = this.add(s.from, seats, true)
        await peer.pc.setLocalDescription(await peer.pc.createOffer())
        this.signal({ from: this.id, to: s.from, sdp: peer.pc.localDescription! })
      } else {
        this.signal({ from: this.id, to: s.from, hello: true })
      }
      return
    }
    if (s.sdp) {
      if (!peer && s.sdp.type === 'offer') peer = this.add(s.from, seats, false)
      if (!peer) return
      await peer.pc.setRemoteDescription(s.sdp)
      peer.described = true
      for (const c of peer.candidates.splice(0)) await peer.pc.addIceCandidate(c)
      if (s.sdp.type === 'offer') {
        await peer.pc.setLocalDescription(await peer.pc.createAnswer())
        this.signal({ from: this.id, to: s.from, sdp: peer.pc.localDescription! })
      }
    } else if (s.candidate && peer) {
      if (peer.described) await peer.pc.addIceCandidate(s.candidate)
      else peer.candidates.push(s.candidate)
    }
  }

  send(m: LinkMsg): void {
    if (m.t === 'i') {
      this.recent.push(m)
      if (this.recent.length > RESEND) this.recent.shift()
    }
    for (const peer of this.peers.values()) if (peer.dc?.readyState === 'open') peer.dc.send(JSON.stringify(m))
    if (!this.direct) this.relay(m)
  }

  close(): void {
    for (const peer of this.peers.values()) {
      peer.dc = undefined
      peer.pc.close()
    }
  }

  private open(): number {
    let n = 0
    for (const peer of this.peers.values()) if (peer.dc?.readyState === 'open') n++
    return n
  }

  private add(id: string, seats: number[], offerer: boolean): Peer {
    const pc = this.connect()
    const peer: Peer = { pc, seats, described: false, candidates: [] }
    this.peers.set(id, peer)
    pc.onicecandidate = (e) => {
      if (e.candidate) this.signal({ from: this.id, to: id, candidate: e.candidate.toJSON() })
    }
    // A dropped channel: anything we sent on it may be lost, so the relay gets our recent inputs again (duplicates are ignored).
    // shortcut: no reconnect — the rest of the session uses the relay for that peer.
    const down = () => {
      if (!peer.dc) return
      peer.dc = undefined
      for (const m of this.recent) this.relay(m)
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') down()
    }
    const attach = (dc: RTCDataChannel) => {
      peer.dc = dc
      dc.onclose = down
      dc.onmessage = (e) => {
        const m = parse(e.data)
        if (m && peer.seats.includes(m.p)) this.receive(m)
      }
    }
    if (offerer) attach(pc.createDataChannel('link', { ordered: true }))
    else pc.ondatachannel = (e) => attach(e.channel)
    return peer
  }
}

function parse(data: unknown): LinkMsg | null {
  if (typeof data !== 'string' || data.length > 200) return null
  try {
    const m = JSON.parse(data) as LinkMsg
    if (!Number.isInteger(m.p) || !Number.isInteger(m.f)) return null
    if (m.t === 'i' && Number.isInteger(m.k)) return { t: 'i', p: m.p, f: m.f, k: m.k }
    if (m.t === 'h' && Number.isInteger(m.h)) return { t: 'h', p: m.p, f: m.f, h: m.h }
  } catch { /* not ours */ }
  return null
}
