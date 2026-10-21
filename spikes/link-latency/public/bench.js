/*
 * Link-play transport bench. No emulator involved: it reproduces the *message
 * pattern* of each link approach over a real transport and measures what a
 * player would feel.
 *
 *   relay-naive   Approach A, one network round trip per serial transfer.
 *                 Gen 3 does 9 transfers per frame (8 command words + checksum,
 *                 pokeemerald src/link.c), each waiting for every GBA.
 *   relay-frame   Approach A, batched: one round trip per frame (needs a
 *                 game-aware driver that knows the frame's words up front).
 *   lockstep      Approach B, every client runs every game; only inputs cross
 *                 the network, D frames ahead. Latency becomes input delay;
 *                 the game only stalls when an input is late.
 *
 * Transports: WebRTC data channel (peer to peer, reliable + ordered) and the
 * server relay (Socket.IO over WebSocket, through server.ts).
 *
 * Modes: loopback (both peers in this page) or pair (?room=x&role=0|1 on two
 * devices). Add ?auto=1 to run the suite on load and post results.
 */
;(function () {
  'use strict'

  var FRAME_MS = 1000 / 59.7275 // GBA refresh rate
  var q = new URLSearchParams(location.search)
  var out = document.getElementById('out')

  function log(line) {
    out.textContent += line + '\n'
    console.log(line)
  }

  // ---------- timing ----------
  var mc = new MessageChannel()
  var yields = []
  mc.port1.onmessage = function () {
    yields.shift()()
  }
  function yieldTask() {
    return new Promise(function (r) {
      yields.push(r)
      mc.port2.postMessage(0)
    })
  }
  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms)
    })
  }
  async function sleepUntil(t) {
    while (performance.now() < t - 3) await sleep(1)
    while (performance.now() < t) await yieldTask()
  }
  function busy(ms) {
    var end = performance.now() + ms
    while (performance.now() < end) {}
  }
  function summarize(xs) {
    if (!xs.length) return { n: 0 }
    var s = xs.slice().sort(function (a, b) {
      return a - b
    })
    function p(x) {
      return round(s[Math.min(s.length - 1, Math.floor(x * s.length))])
    }
    var sum = s.reduce(function (a, b) {
      return a + b
    }, 0)
    return { n: s.length, mean: round(sum / s.length), p50: p(0.5), p95: p(0.95), p99: p(0.99), max: round(s[s.length - 1]) }
  }
  function round(x) {
    return Math.round(x * 100) / 100
  }

  // ---------- transports ----------
  // An endpoint is { send(msg), onmsg, close() } carrying small JSON arrays.

  function connectSocket(room) {
    return new Promise(function (resolve) {
      var socket = io({ transports: ['websocket'] })
      // Buffer signalling until webrtcPair attaches, so an early offer isn't lost.
      socket.sigBuf = []
      socket.on('signal', function (m) {
        if (socket.onSignal) socket.onSignal(m)
        else socket.sigBuf.push(m)
      })
      socket.peers = 0
      socket.on('peers', function (n) {
        socket.peers = n
      })
      socket.on('connect', function () {
        socket.emit('join', room)
        resolve(socket)
      })
    })
  }

  // Resolves once both peers are in the relay room, so nothing is sent into the void.
  async function relayEndpoint(room) {
    var socket = await connectSocket(room)
    await waitPeers(socket, 2)
    var ep = {
      kind: 'relay',
      onmsg: null,
      send: function (m) {
        socket.emit('r', m)
      },
      close: function () {
        socket.close()
      },
    }
    socket.on('r', function (m) {
      ep.onmsg(m)
    })
    return ep
  }

  function waitPeers(socket, n) {
    return new Promise(function (r) {
      if (socket.peers >= n) return r()
      socket.on('peers', function (k) {
        if (k >= n) r()
      })
    })
  }

  function dcEndpoint(pc, dc) {
    var ep = {
      kind: 'webrtc',
      onmsg: null,
      send: function (m) {
        dc.send(JSON.stringify(m))
      },
      close: function () {
        pc.close()
      },
      pc: pc,
    }
    dc.onmessage = function (e) {
      ep.onmsg(JSON.parse(e.data))
    }
    return ep
  }

  function waitOpen(dc) {
    return new Promise(function (r) {
      if (dc.readyState === 'open') r()
      else dc.onopen = r
    })
  }

  // Candidates can arrive before the remote description is set; hold them until it is.
  function iceQueue(pc) {
    var pending = []
    var isReady = false
    function add(c) {
      pc.addIceCandidate(c).catch(function (err) {
        log('ICE candidate rejected: ' + err)
      })
    }
    return {
      add: function (c) {
        if (isReady) add(c)
        else pending.push(c)
      },
      ready: function () {
        isReady = true
        pending.splice(0).forEach(add)
      },
    }
  }

  // No STUN/TURN: host candidates only, i.e. same machine or same network.
  async function webrtcLoopback() {
    var a = new RTCPeerConnection({ iceServers: [] })
    var b = new RTCPeerConnection({ iceServers: [] })
    var qa = iceQueue(a)
    var qb = iceQueue(b)
    a.onicecandidate = function (e) {
      if (e.candidate) qb.add(e.candidate)
    }
    b.onicecandidate = function (e) {
      if (e.candidate) qa.add(e.candidate)
    }
    var dcA = a.createDataChannel('link', { ordered: true })
    var gotB = new Promise(function (r) {
      b.ondatachannel = function (e) {
        r(e.channel)
      }
    })
    await a.setLocalDescription(await a.createOffer())
    await b.setRemoteDescription(a.localDescription)
    qb.ready()
    await b.setLocalDescription(await b.createAnswer())
    await a.setRemoteDescription(b.localDescription)
    qa.ready()
    var dcB = await gotB
    await Promise.all([waitOpen(dcA), waitOpen(dcB)])
    return [dcEndpoint(a, dcA), dcEndpoint(b, dcB)]
  }

  async function webrtcPair(socket, role) {
    var pc = new RTCPeerConnection({ iceServers: [] })
    var queue = iceQueue(pc)
    pc.onicecandidate = function (e) {
      if (e.candidate) socket.emit('signal', { candidate: e.candidate.toJSON() })
    }
    var dcP
    if (role === 0) {
      var dc = pc.createDataChannel('link', { ordered: true })
      dcP = Promise.resolve(dc)
    } else {
      dcP = new Promise(function (r) {
        pc.ondatachannel = function (e) {
          r(e.channel)
        }
      })
    }
    socket.onSignal = async function (s) {
      if (s.sdp) {
        await pc.setRemoteDescription(s.sdp)
        queue.ready()
        if (s.sdp.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer())
          socket.emit('signal', { sdp: pc.localDescription })
        }
      } else if (s.candidate) {
        queue.add(s.candidate)
      }
    }
    socket.sigBuf.splice(0).forEach(socket.onSignal)
    if (role === 0) {
      await pc.setLocalDescription(await pc.createOffer())
      socket.emit('signal', { sdp: pc.localDescription })
    }
    var channel = await dcP
    await waitOpen(channel)
    return dcEndpoint(pc, channel)
  }

  // Which ICE path WebRTC picked (host = direct on the LAN / same machine).
  async function iceRoute(ep) {
    if (!ep.pc) return null
    var report = await ep.pc.getStats()
    var pair = null
    var byId = {}
    report.forEach(function (s) {
      byId[s.id] = s
      if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) pair = s
    })
    if (!pair) return null
    var l = byId[pair.localCandidateId] || {}
    var r = byId[pair.remoteCandidateId] || {}
    return { local: l.candidateType, remote: r.candidateType, protocol: l.protocol, rttMs: pair.currentRoundTripTime * 1000 }
  }

  // Simulated extra latency, applied on receive, order preserved.
  function withDelay(ep, oneWayMs, jitterMs) {
    if (!oneWayMs && !jitterMs) return ep
    var last = 0
    var wrapped = Object.assign({}, ep, { onmsg: null })
    ep.onmsg = function (m) {
      var at = Math.max(last, performance.now() + oneWayMs + Math.random() * jitterMs)
      last = at
      setTimeout(function () {
        wrapped.onmsg(m)
      }, at - performance.now())
    }
    return wrapped
  }

  // ---------- peer protocol ----------
  function makePeer(ep) {
    var peer = { ep: ep, waiters: new Map(), inputs: new Map(), inputWaiter: null, resultWaiter: null, seq: 0 }
    ep.onmsg = function (m) {
      switch (m[0]) {
        case 'p': // request: echo immediately (optimistic remote GBA)
          ep.send(['P', m[1], m[2]])
          break
        case 'P': {
          var w = peer.waiters.get(m[1])
          if (w) {
            peer.waiters.delete(m[1])
            w()
          }
          break
        }
        case 'i':
          peer.inputs.set(m[1], m[2])
          if (peer.inputWaiter && peer.inputWaiter.f === m[1]) {
            var iw = peer.inputWaiter
            peer.inputWaiter = null
            iw.resolve()
          }
          break
        case 'c':
          onControl(peer, m[1])
          break
      }
    }
    peer.exchange = function (payload) {
      return new Promise(function (res) {
        var id = ++peer.seq
        peer.waiters.set(id, res)
        ep.send(['p', id, payload])
      })
    }
    peer.waitInput = function (f) {
      if (peer.inputs.has(f)) return Promise.resolve()
      return new Promise(function (resolve) {
        peer.inputWaiter = { f: f, resolve: resolve }
      })
    }
    return peer
  }

  async function onControl(peer, msg) {
    if (msg.go === 'lockstep') {
      var s = await lockstep(peer, msg)
      peer.ep.send(['c', { result: s }])
    } else if (msg.result && peer.resultWaiter) {
      peer.resultWaiter(msg.result)
    }
  }

  // ---------- tests ----------
  async function ping(peer, n) {
    var rtts = []
    for (var i = 0; i < n; i++) {
      var t0 = performance.now()
      await peer.exchange(0)
      rtts.push(performance.now() - t0)
      await sleep(4)
    }
    return { rttMs: summarize(rtts) }
  }

  // Approach A: the master GBA's frame can't finish until `perFrame` round trips are done.
  async function relayLink(peer, perFrame, seconds, emuMs) {
    var frames = []
    var start = performance.now()
    var next = start
    var end = start + seconds * 1000
    var words = [1, 2, 3, 4, 5, 6, 7, 8]
    while (performance.now() < end) {
      var t0 = performance.now()
      busy(emuMs)
      for (var k = 0; k < perFrame; k++) await peer.exchange(perFrame === 1 ? words : k)
      next += FRAME_MS
      if (performance.now() < next) await sleepUntil(next)
      else next = performance.now() // fell behind: the game slows down, no catch-up
      frames.push(performance.now() - t0)
    }
    var elapsed = (performance.now() - start) / 1000
    return { fps: round(frames.length / elapsed), speedPct: round((frames.length / elapsed / 59.7275) * 100), frameMs: summarize(frames) }
  }

  // Approach B: send my input D frames ahead; stall only if the remote input for this frame is late.
  async function lockstep(peer, opts) {
    var D = opts.D
    var total = Math.round(opts.seconds * 59.7275)
    peer.inputs = new Map()
    peer.inputWaiter = null
    for (var f0 = 0; f0 < D; f0++) peer.inputs.set(f0, 0)
    var stalls = []
    var stalled = 0
    var start = performance.now()
    var next = start
    for (var f = 0; f < total; f++) {
      peer.ep.send(['i', f + D, f & 0x3ff])
      var t = performance.now()
      await Promise.race([peer.waitInput(f), sleep(5000)])
      var waited = performance.now() - t
      if (waited > 1) {
        stalled++
        stalls.push(waited)
      }
      peer.inputs.delete(f)
      busy(opts.emuMs * opts.cores)
      next += FRAME_MS
      if (performance.now() < next) await sleepUntil(next)
      else next = performance.now()
    }
    var elapsed = (performance.now() - start) / 1000
    return {
      D: D,
      inputDelayMs: round(D * FRAME_MS),
      fps: round(total / elapsed),
      speedPct: round((total / elapsed / 59.7275) * 100),
      stalledFramesPct: round((stalled / total) * 100),
      stallMs: summarize(stalls),
    }
  }

  async function runLockstep(peer, D, seconds, emuMs, cores) {
    var remote = new Promise(function (r) {
      peer.resultWaiter = r
    })
    var opts = { go: 'lockstep', D: D, seconds: seconds, emuMs: emuMs, cores: cores }
    peer.ep.send(['c', opts])
    var local = await lockstep(peer, opts)
    var other = await Promise.race([remote, sleep(10000).then(function () {
      return null
    })])
    return { local: local, remote: other }
  }

  // ---------- suite ----------
  var PROFILES = {
    none: { oneWayMs: 0, jitterMs: 0, note: 'real transport only' },
    'wifi-lan-sim': { oneWayMs: 2, jitterMs: 3, note: 'simulated busy home Wi-Fi: +4-10 ms RTT' },
    'region-sim': { oneWayMs: 10, jitterMs: 5, note: 'simulated same-region internet: +20-30 ms RTT' },
  }

  async function suite(cfg, endpoints) {
    var results = []
    var seconds = cfg.seconds
    for (var pi = 0; pi < cfg.profiles.length; pi++) {
      var pname = cfg.profiles[pi]
      var prof = PROFILES[pname]
      for (var ti = 0; ti < endpoints.length; ti++) {
        var pair = endpoints[ti]
        var a = makePeer(withDelay(pair[0], prof.oneWayMs, prof.jitterMs))
        if (pair[1]) makePeer(withDelay(pair[1], prof.oneWayMs, prof.jitterMs))
        var base = { profile: pname, profileNote: prof.note, transport: pair[0].kind, route: await iceRoute(pair[0]) }
        log('\n== ' + pname + ' / ' + base.transport + (base.route ? ' (' + base.route.local + ' ↔ ' + base.route.remote + ')' : ''))

        var r = Object.assign({ test: 'ping' }, base, await ping(a, cfg.pings))
        results.push(r)
        log('ping          rtt p50 ' + r.rttMs.p50 + '  p95 ' + r.rttMs.p95 + '  p99 ' + r.rttMs.p99 + '  max ' + r.rttMs.max + ' ms')

        r = Object.assign({ test: 'relay-naive', transfersPerFrame: 9, emuMs: cfg.emuMs }, base, await relayLink(a, 9, seconds, cfg.emuMs))
        results.push(r)
        log('relay-naive   ' + r.fps + ' fps (' + r.speedPct + '% speed)  frame p95 ' + r.frameMs.p95 + ' ms')

        r = Object.assign({ test: 'relay-frame', transfersPerFrame: 1, emuMs: cfg.emuMs }, base, await relayLink(a, 1, seconds, cfg.emuMs))
        results.push(r)
        log('relay-frame   ' + r.fps + ' fps (' + r.speedPct + '% speed)  frame p95 ' + r.frameMs.p95 + ' ms')

        for (var di = 0; di < cfg.delays.length; di++) {
          var D = cfg.delays[di]
          var ls = await runLockstep(a, D, seconds, cfg.lockstepEmuMs, cfg.cores)
          r = Object.assign({ test: 'lockstep', cores: cfg.cores, emuMs: cfg.lockstepEmuMs }, base, ls)
          results.push(r)
          log(
            'lockstep D=' + D + '  input delay ' + ls.local.inputDelayMs + ' ms  ' + ls.local.fps + ' fps  stalled frames ' +
              ls.local.stalledFramesPct + '%  stall p95 ' + (ls.local.stallMs.p95 || 0) + ' ms'
          )
        }
      }
    }
    return results
  }

  async function main() {
    var mode = q.get('mode') || 'loopback'
    var cfg = {
      label: q.get('label') || mode,
      seconds: Number(q.get('seconds') || 8),
      pings: Number(q.get('pings') || 500),
      emuMs: Number(q.get('emu') || 4), // assumed cost of one GBA frame in WebAssembly
      lockstepEmuMs: Number(q.get('lsemu') || (mode === 'loopback' ? 0 : 4)),
      cores: Number(q.get('cores') || 2),
      delays: (q.get('delays') || '1,2,3,4').split(',').map(Number),
      profiles: (q.get('profiles') || (mode === 'loopback' ? 'none,wifi-lan-sim,region-sim' : 'none')).split(','),
      transports: (q.get('transports') || 'webrtc,relay').split(','),
    }
    log('config ' + JSON.stringify(cfg))
    var endpoints = []
    var room = q.get('room') || 'lb-' + Math.random().toString(36).slice(2, 8)

    if (mode === 'loopback') {
      for (var i = 0; i < cfg.transports.length; i++) {
        if (cfg.transports[i] === 'webrtc') endpoints.push(await webrtcLoopback())
        else endpoints.push(await Promise.all([relayEndpoint(room + '-r'), relayEndpoint(room + '-r')]))
      }
    } else {
      var role = Number(q.get('role') || 0)
      var signal = await connectSocket(room + '-s')
      log('waiting for the other device in room ' + room + ' …')
      await waitPeers(signal, 2)
      for (var j = 0; j < cfg.transports.length; j++) {
        if (cfg.transports[j] === 'webrtc') endpoints.push([await webrtcPair(signal, role)])
        else endpoints.push([await relayEndpoint(room + '-r')])
      }
      if (role !== 0) {
        endpoints.forEach(function (p) {
          makePeer(p[0])
        })
        log('connected — this device answers; results appear on the role=0 device')
        return
      }
      await sleep(500) // let the answering side attach its handlers
    }

    var results = await suite(cfg, endpoints)
    var payload = { label: cfg.label, mode: mode, config: cfg, userAgent: navigator.userAgent, at: new Date().toISOString(), results: results }
    var res = await fetch('/results', { method: 'POST', body: JSON.stringify(payload) })
    log('\nsaved ' + (await res.text()))
    document.title = 'done'
  }

  document.getElementById('run').onclick = function () {
    this.disabled = true
    main()
  }
  if (q.get('auto') === '1' || q.get('role') === '1') main()
})()
