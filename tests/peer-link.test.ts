import { PeerLinks, type LinkMsg, type Signal } from '@/lib/client/peer-link'

// Just enough of RTCPeerConnection: an offer names its connection, and the answer opens a channel pair between them.
const offers = new Map<string, FakePc>()

class FakeChannel {
  readyState = 'connecting'
  other?: FakeChannel
  onmessage?: (e: { data: string }) => void
  onclose?: () => void
  send(data: string) { this.other!.onmessage?.({ data }) }
}

class FakePc {
  onicecandidate?: (e: { candidate: null }) => void
  ondatachannel?: (e: { channel: FakeChannel }) => void
  onconnectionstatechange?: () => void
  connectionState = 'new'
  localDescription: RTCSessionDescriptionInit | null = null
  channel?: FakeChannel
  offerer?: FakePc
  createDataChannel() { return (this.channel = new FakeChannel()) }
  async createOffer() { const sdp = String(offers.size); offers.set(sdp, this); return { type: 'offer' as const, sdp } }
  async createAnswer() { return { type: 'answer' as const, sdp: '' } }
  async setLocalDescription(d: RTCSessionDescriptionInit) {
    this.localDescription = d
    if (d.type !== 'answer') return
    const mine = new FakeChannel()
    const theirs = this.offerer!.channel!
    mine.other = theirs; theirs.other = mine
    mine.readyState = theirs.readyState = 'open'
    this.channel = mine
    this.ondatachannel?.({ channel: mine })
  }
  async setRemoteDescription(d: RTCSessionDescriptionInit) { if (d.type === 'offer') this.offerer = offers.get(d.sdp!) }
  async addIceCandidate() {}
  close() {}
}

const tick = () => new Promise((r) => setTimeout(r, 0))

function pair() {
  const relayed: LinkMsg[][] = [[], []]
  const got: LinkMsg[][] = [[], []]
  const links: PeerLinks[] = []
  const seats = [[0], [1]]
  for (const i of [0, 1]) {
    links[i] = new PeerLinks(
      1,
      (s: Signal) => void links[1 - i].onSignal(JSON.parse(JSON.stringify(s)), seats[i]),
      (m) => relayed[i].push(m),
      (m) => got[i].push(m),
      () => new FakePc() as unknown as RTCPeerConnection,
    )
  }
  return { links, relayed, got }
}

describe('PeerLinks (ADR-012 peer to peer)', () => {
  it('uses the relay until the channel opens, then sends directly', async () => {
    const { links, relayed, got } = pair()
    links[0].send({ t: 'i', p: 0, f: 2, k: 1 })
    expect(relayed[0]).toHaveLength(1)
    links[0].hello(); links[1].hello()
    for (let n = 0; n < 5; n++) await tick()
    expect(links[0].direct && links[1].direct).toBe(true)
    links[0].send({ t: 'i', p: 0, f: 3, k: 4 })
    links[1].send({ t: 'h', p: 1, f: 0, h: 99 })
    expect(relayed[0]).toHaveLength(1)
    expect(relayed[1]).toHaveLength(0)
    expect(got[1]).toEqual([{ t: 'i', p: 0, f: 3, k: 4 }])
    expect(got[0]).toEqual([{ t: 'h', p: 1, f: 0, h: 99 }])
  })

  it("drops a peer's messages for seats it doesn't hold", async () => {
    const { links, got } = pair()
    links[0].hello(); links[1].hello()
    for (let n = 0; n < 5; n++) await tick()
    links[0].send({ t: 'i', p: 1, f: 3, k: 4 })
    expect(got[1]).toEqual([])
  })

  it('re-sends recent inputs through the relay when the channel drops', async () => {
    const { links, relayed } = pair()
    links[0].hello(); links[1].hello()
    for (let n = 0; n < 5; n++) await tick()
    links[0].send({ t: 'i', p: 0, f: 3, k: 4 })
    const pc = (links[0] as unknown as { peers: Map<string, { pc: FakePc }> }).peers.values().next().value!.pc
    pc.connectionState = 'failed'
    pc.onconnectionstatechange!()
    expect(relayed[0].map((m) => m.f)).toEqual([3])
    links[0].send({ t: 'i', p: 0, f: 4, k: 0 })
    expect(relayed[0].map((m) => m.f)).toEqual([3, 4])
  })
})
