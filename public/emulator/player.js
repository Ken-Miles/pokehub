/*
 * Pokémon Hub's emulator page: our mGBA WebAssembly build (ADR-011) with
 * 1–4 GBAs, linked by an in-memory cable when there is more than one (ADR-018),
 * or one GB/GBA whose cable runs over the network (ADR-020, ADR-021), or one DS on
 * our melonDS build (FR-07; ds/, same C API, both screens in one 256×384 canvas).
 *
 * The parent page drives every frame, so solo play and lockstep link play are
 * the same loop (lib/client/emulator.ts):
 *
 * parent → iframe   { type: 'boot', platform: 'GBA' | 'GB' | 'NDS' (default 'GBA'), games: [{ rom, save, patch }], local: [core…], audioFrom, rtc: { mode: 'wall' } | { mode: 'fixed', epochMs } }
 *                   { type: 'frame', count, inputs?: number[], hash?: boolean }
 *                       inputs = key bits per core (lockstep); without it, each local core reads this page's devices
 *                   { type: 'cable-plug', on: boolean, seat?, delay? } — one game: plug the network cable in/out (plugged = linked, no states)
 *                       GBA also needs seat (0 = parent, 1 = child) and the parent's delay in frames (1–30)
 *                   { type: 'cable', k, b, n } — the peer's cable message; n = its sequence number (from 1 per plug-in)
 *                       GB:  k 0 = ready, 1 = clock; b = byte
 *                       GBA: k 2 = pair (to the child; b = parent word | child word << 16), 3 = frame end (b 0),
 *                            4 = word (to the parent; b = the child's 16-bit word)
 *                   { type: 'air-plug', on: boolean, seat } — GBA: turn the wireless adapter on/off as room seat 0–15 (on = linked, no states)
 *                     quiet: true with on: false — out of the room: the adapter stays plugged in with nobody in range
 *                   { type: 'air', op, from, d: number[] } — a message from the adapter in room seat `from` (op 1–7, d ≤ 24 words)
 *                   { type: 'pause' } | { type: 'resume' }
 *                   { type: 'flush' } — "Sync now": read save RAM immediately
 *                   { type: 'clear-states' } — the cloud save changed elsewhere (ADR-016)
 *                   { type: 'bind', action, code } | { type: 'reset-bindings' }
 * iframe → parent   { type: 'ready' } | { type: 'started', build }
 *                   { type: 'error', crashed, message, stack?, frames?, linked?, build?, recent }
 *                       crashed = the core died while running (the page is dead; reload it), else it wouldn't boot
 *                   { type: 'framed', local: number[], hash?: number, stalls: number }
 *                       local = keys held on this page per local core, sampled after the frame
 *                   { type: 'save', core, bytes: ArrayBuffer, sha256: string }
 *                   { type: 'unchanged' } — answer to a flush with nothing new
 *                   { type: 'controls', keys: [{ id, key, pad }], players: number }
 *                   { type: 'cable', k, b, n } — one per outgoing cable message, posted after each frame message
 *                   'framed' also carries waiting: true when a GBA cable parent held a frame back for its child
 *                   { type: 'air', op, to, d: number[] } — one per message from this page's wireless adapter, after each
 *                       frame message; to = a room seat, or 255 = everyone in the room
 *                       op 1 beacon, 2 beacon off, 3 join, 4 accept, 5 reject, 6 data, 7 leave
 *
 * Game files arrive as bytes from the parent and never leave this page. Save
 * states live only in this page's memory, and not at all while linked: a state
 * loaded mid-session would break lockstep and could undo a link trade.
 */
;(function () {
  'use strict'

  var origin = location.origin
  var POLL_MS = 2000
  var STATE_SLOTS = 9
  var AUDIO_STORAGE_KEY = 'pokehub.audio.v1'

  // GBA key register bits (a Game Boy uses the first eight); a DS adds X and Y at boot.
  var BITS = { a: 0, b: 1, select: 2, start: 3, right: 4, left: 5, up: 6, down: 7, r: 8, l: 9 }
  // KeyboardEvent.code per action; hotkeys after the GBA buttons. X and Y are kept on every
  // page so a GBA page doesn't drop the account's DS bindings when it saves the map.
  var DEFAULT_KEYS = {
    a: 'KeyX', b: 'KeyZ', l: 'KeyA', r: 'KeyS', start: 'Enter', select: 'Backspace',
    up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    x: 'KeyW', y: 'KeyQ',
    save: 'F2', load: 'F4', slot: 'F3',
  }
  var ACTIONS = Object.keys(DEFAULT_KEYS)
  // Standard gamepad mapping, by position (Nintendo layout: A is the right face button).
  var PAD = { a: 1, b: 0, l: 4, r: 5, select: 8, start: 9, up: 12, down: 13, left: 14, right: 15 }
  var PAD_NAMES = {
    0: 'BUTTON_1', 1: 'BUTTON_2', 2: 'BUTTON_3', 3: 'BUTTON_4', 4: 'LEFT_TOP_SHOULDER', 5: 'RIGHT_TOP_SHOULDER',
    8: 'SELECT', 9: 'START', 12: 'DPAD_UP', 13: 'DPAD_DOWN', 14: 'DPAD_LEFT', 15: 'DPAD_RIGHT',
  }

  var hub = null
  var ds = false // a melonDS page (FR-07): one DS, both screens in one canvas, touch on the lower half
  var booting = false
  var cores = 0
  var local = [] // cores this page plays, in player order
  var linked = false
  var cablePlugged = false
  var airOn = false // the adapter is plugged in
  var airRoom = false // and in a room
  var paused = false
  var keys = Object.assign({}, DEFAULT_KEYS)
  var held = {} // KeyboardEvent.code → true
  var states = {} // slot → Uint8Array (solo only)
  var stateSlot = 1
  var lastHash = {} // core → hash of the save the server has
  var pendingHash = {} // core → seen once; reported when the next poll agrees
  var screens = []
  var audio = null
  var audioSettings = loadAudioSettings()
  var messageTimer = null
  var build = null
  var framesRun = 0
  var crashed = false
  var recent = [] // last console warnings/errors, sent with a crash report

  function post(msg, transfer) {
    parent.postMessage(msg, origin, transfer || [])
  }

  ;['warn', 'error'].forEach(function (level) {
    var original = console[level]
    console[level] = function () {
      var line = Array.prototype.map.call(arguments, String).join(' ')
      recent.push(level + ': ' + line.slice(0, 500))
      if (recent.length > 20) recent.shift()
      original.apply(console, arguments)
    }
  })

  // The core died (a WebAssembly trap, an abort): stop for good and tell the parent once, with what we know.
  function crash(e) {
    if (crashed) return
    crashed = true
    hub = null
    post({
      type: 'error',
      crashed: true,
      message: (e && e.message) || String(e),
      stack: e && e.stack ? String(e.stack) : undefined,
      frames: framesRun,
      linked: linked,
      build: build,
      recent: recent.slice(),
    })
  }
  window.addEventListener('error', function (e) { crash(e.error || e.message) })
  window.addEventListener('unhandledrejection', function (e) { crash(e.reason) })

  function loadAudioSettings() {
    try {
      var saved = JSON.parse(localStorage.getItem(AUDIO_STORAGE_KEY) || '{}')
      return { muted: !!saved.muted, volume: typeof saved.volume === 'number' ? Math.max(0, Math.min(1, saved.volume)) : 1 }
    } catch (e) {
      return { muted: false, volume: 1 }
    }
  }

  function reportAudio() {
    post({ type: 'audio', state: audio ? audio.ctx.state : 'unavailable' })
  }

  function reportControls() {
    post({
      type: 'controls',
      keys: ACTIONS.map(function (id) {
        return { id: id, key: keys[id] || null, pad: id in PAD ? PAD_NAMES[PAD[id]] : null }
      }),
      muted: audioSettings.muted,
      volume: audioSettings.volume,
      players: local.length,
    })
  }

  function say(text) {
    var el = document.getElementById('message')
    el.textContent = text
    el.hidden = false
    clearTimeout(messageTimer)
    messageTimer = setTimeout(function () {
      el.hidden = true
    }, 2500)
  }

  async function sha256(bytes) {
    var digest = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest), function (b) {
      return b.toString(16).padStart(2, '0')
    }).join('')
  }

  // ------------------------------------------------------------ input

  function padKeys(pad) {
    var bits = 0
    if (!pad) return 0
    for (var action in PAD) if (pad.buttons[PAD[action]] && pad.buttons[PAD[action]].pressed) bits |= 1 << BITS[action]
    var x = pad.axes[0] || 0
    var y = pad.axes[1] || 0
    if (x < -0.5) bits |= 1 << BITS.left
    if (x > 0.5) bits |= 1 << BITS.right
    if (y < -0.5) bits |= 1 << BITS.up
    if (y > 0.5) bits |= 1 << BITS.down
    return bits
  }

  function keyboardKeys() {
    var bits = 0
    for (var action in BITS) if (held[keys[action]]) bits |= 1 << BITS[action]
    return bits
  }

  /**
   * Keys per local player. One player: keyboard, touch and any gamepad. Two or
   * more on this device: player 1 on the keyboard and touch, the others on
   * gamepads in order.
   */
  function sampleLocal() {
    var pads = navigator.getGamepads ? Array.prototype.filter.call(navigator.getGamepads(), Boolean) : []
    if (local.length === 1) {
      return [keyboardKeys() | touchKeys() | pads.reduce(function (acc, p) { return acc | padKeys(p) }, 0)]
    }
    return local.map(function (_, i) {
      return i === 0 ? keyboardKeys() | touchKeys() : padKeys(pads[i - 1])
    })
  }

  // ------------------------------------------------------------ touch controls

  var touches = {} // pointerId → key bits under that finger

  function touchKeys() {
    var bits = 0
    for (var id in touches) bits |= touches[id]
    return bits
  }

  /** Key bits under a point; fingers can slide between buttons and around the D-pad. */
  function keysAt(x, y) {
    var el = document.elementFromPoint(x, y)
    var button = el && el.closest('#pad [data-key]')
    if (!button) return 0
    if (button.dataset.key !== 'dpad') return 1 << BITS[button.dataset.key]
    var box = button.getBoundingClientRect()
    var dx = (x - box.left) / box.width - 0.5
    var dy = (y - box.top) / box.height - 0.5
    var bits = 0
    // Diagonals only when the finger is clearly between two arms.
    if (Math.abs(dx) > 0.12 && Math.abs(dx) > Math.abs(dy) * 0.5) bits |= 1 << (dx < 0 ? BITS.left : BITS.right)
    if (Math.abs(dy) > 0.12 && Math.abs(dy) > Math.abs(dx) * 0.5) bits |= 1 << (dy < 0 ? BITS.up : BITS.down)
    return bits
  }

  function showTouches() {
    var bits = touchKeys()
    document.querySelectorAll('#pad [data-key]').forEach(function (el) {
      var key = el.dataset.key
      el.classList.toggle('on', key !== 'dpad' && !!(bits & (1 << BITS[key])))
    })
  }

  function onTouch(e) {
    if (e.pointerType === 'mouse') return
    e.preventDefault()
    if (e.type === 'pointerup' || e.type === 'pointercancel') delete touches[e.pointerId]
    else if (e.type === 'pointerdown' || e.pointerId in touches) touches[e.pointerId] = keysAt(e.clientX, e.clientY)
    showTouches()
  }

  ;['pointerdown', 'pointermove', 'pointerup', 'pointercancel'].forEach(function (type) {
    document.getElementById('pad').addEventListener(type, onTouch)
  })

  function onKey(e, down) {
    if (!(e.code in held) && !down) return
    var action = ACTIONS.find(function (a) { return keys[a] === e.code })
    if (action) e.preventDefault()
    if (down && !held[e.code] && !e.repeat) hotkey(action)
    if (down) held[e.code] = true
    else delete held[e.code]
    if (audio) audio.ctx.resume().catch(function () {})
  }

  function hotkey(action) {
    if (action !== 'save' && action !== 'load' && action !== 'slot') return
    if (linked) return say('Save states are off while linked')
    if (action === 'slot') {
      stateSlot = (stateSlot % STATE_SLOTS) + 1
      return say('State slot ' + stateSlot)
    }
    var core = local[0]
    if (action === 'save') {
      var size = hub._hub_state_size(core)
      var ptr = hub._malloc(size)
      var ok = hub._hub_state_save(core, ptr)
      if (ok) states[stateSlot] = hub.HEAPU8.slice(ptr, ptr + size)
      hub._free(ptr)
      return say(ok ? 'Saved state to slot ' + stateSlot + ' (this tab only)' : 'Failed to save state')
    }
    var state = states[stateSlot]
    if (!state) return say('No state in slot ' + stateSlot)
    var p = hub._malloc(state.length)
    hub.HEAPU8.set(state, p)
    var loaded = hub._hub_state_load(core, p, state.length) // mGBA ignores the length
    hub._free(p)
    say(loaded || !ds ? 'Loaded state from slot ' + stateSlot : 'Failed to load state')
  }

  // ------------------------------------------------------------ video and audio

  function makeScreens() {
    var root = document.getElementById('screens')
    root.className = local.length > 1 ? 'split' : ''
    screens = local.map(function (core, i) {
      var size = hub._hub_video_size(core)
      var canvas = document.createElement('canvas')
      canvas.width = size >>> 16
      canvas.height = size & 0xffff
      canvas.style.aspectRatio = canvas.width + ' / ' + canvas.height
      canvas.tabIndex = 0
      canvas.setAttribute('aria-label', local.length > 1 ? 'Player ' + (i + 1) : ds ? 'Game screens; the lower one is the touch screen' : 'Game screen')
      if (ds) touchScreen(canvas)
      root.appendChild(canvas)
      var ctx = canvas.getContext('2d')
      return { core: core, ctx: ctx, image: ctx.createImageData(canvas.width, canvas.height) }
    })
    if (screens[0]) screens[0].ctx.canvas.focus()
  }

  // DS touch screen (FR-07): the lower half of the canvas, by mouse, pen or finger.
  function touchScreen(canvas) {
    var pointer = null
    function at(e) {
      var r = canvas.getBoundingClientRect()
      var x = Math.floor(((e.clientX - r.left) * 256) / r.width)
      var y = Math.floor(((e.clientY - r.top) * 384) / r.height) - 192
      if (y < 0) return hub._hub_release() // slid onto the top screen
      hub._hub_touch(Math.max(0, Math.min(255, x)), Math.min(191, y))
    }
    canvas.style.touchAction = 'none'
    canvas.addEventListener('pointerdown', function (e) {
      if (!hub || pointer !== null) return
      pointer = e.pointerId
      try { canvas.setPointerCapture(e.pointerId) } catch (err) { /* the pointer already went away */ }
      at(e)
    })
    canvas.addEventListener('pointermove', function (e) {
      if (hub && e.pointerId === pointer) at(e)
    })
    ;['pointerup', 'pointercancel'].forEach(function (type) {
      canvas.addEventListener(type, function (e) {
        if (e.pointerId !== pointer) return
        pointer = null
        if (hub) hub._hub_release()
      })
    })
  }

  function draw() {
    for (var i = 0; i < screens.length; i++) {
      var s = screens[i]
      var ptr = hub._hub_video(s.core)
      s.image.data.set(hub.HEAPU8.subarray(ptr, ptr + s.image.data.length))
      s.ctx.putImageData(s.image, 0, 0)
    }
  }

  async function startAudio() {
    try {
      var Audio = window.AudioContext || window.webkitAudioContext
      if (!Audio) throw new Error('Web Audio is unavailable in this browser.')
      var ctx = new Audio({ latencyHint: 'interactive' })
      // Schedule short PCM buffers directly on the destination. This avoids
      // both AudioWorklet startup restrictions and ScriptProcessor callbacks,
      // which can be throttled when the emulator is inside an iframe.
      audio = {
        ctx: ctx,
        rate: ctx.sampleRate,
        nextTime: 0,
        sources: [],
        push: function (samples) {
          var sampleFrames = samples.length >> 1
          if (ctx.state !== 'running' || !sampleFrames) {
            this.nextTime = ctx.currentTime
            return
          }
          var duration = sampleFrames / ctx.sampleRate
          var when = Math.max(this.nextTime, ctx.currentTime + 0.025)
          if (when > ctx.currentTime + 0.2) {
            this.sources.forEach(function (source) { try { source.stop() } catch (e) {} })
            this.sources = []
            when = ctx.currentTime + 0.025
          }
          var buffer = ctx.createBuffer(2, sampleFrames, ctx.sampleRate)
          var left = buffer.getChannelData(0)
          var right = buffer.getChannelData(1)
          for (var i = 0; i < sampleFrames; i++) {
            left[i] = samples[i * 2]
            right[i] = samples[i * 2 + 1]
          }
          var source = ctx.createBufferSource()
          source.buffer = buffer
          source.connect(ctx.destination)
          this.sources.push(source)
          var sources = this.sources
          source.onended = function () {
            var index = sources.indexOf(source)
            if (index >= 0) sources.splice(index, 1)
            source.disconnect()
          }
          source.start(when)
          this.nextTime = when + duration
        },
      }
      ctx.addEventListener('statechange', reportAudio)
      reportAudio()
    } catch (e) {
      audio = null
      reportAudio()
    }
  }

  // Called directly by the parent settings button so resume() runs inside the
  // user's click activation. A postMessage handler runs in a later task and can
  // be rejected by browsers' autoplay policy.
  window.enableHubAudio = function () {
    if (audio) {
      audio.ctx.resume().catch(function () {})
      return
    }
    startAudio().then(function () {
      if (audio) audio.ctx.resume().catch(function () {})
    })
  }

  function pushAudio(dropForCatchup) {
    var frames = hub.audioFrames | 0
    var pcm = null
    if (frames) {
      var ptr = hub._hub_audio() >> 1
      pcm = hub.HEAP16.subarray(ptr, ptr + frames * 2)
    }
    if (!audio || !frames || dropForCatchup) return
    var out = new Float32Array(frames * 2)
    var gain = audioSettings.muted ? 0 : audioSettings.volume
    for (var i = 0; i < out.length; i++) out[i] = (pcm[i] / 32768) * gain
    audio.push(out)
  }

  // ------------------------------------------------------------ saves

  function readSave(core) {
    var size = hub._hub_save_read(core)
    if (!size) return null
    var ptr = hub._hub_save_data()
    return hub.HEAPU8.slice(ptr, ptr + size)
  }

  // `force` (Sync now) skips the two-poll debounce: the player asked for it.
  async function poll(force) {
    if (!hub) {
      if (force) {
        post({ type: 'unchanged' })
        post({ type: 'flushed' })
      }
      return
    }
    var sent = false
    for (var i = 0; i < local.length; i++) {
      var core = local[i]
      var bytes = readSave(core)
      if (!bytes) continue
      var hash = await sha256(bytes)
      if (hash === lastHash[core]) {
        pendingHash[core] = null
        continue
      }
      // Debounce: only report once two polls agree, so a save in progress isn't sent half-written.
      if (!force && hash !== pendingHash[core]) {
        pendingHash[core] = hash
        continue
      }
      lastHash[core] = hash
      pendingHash[core] = null
      sent = true
      post({ type: 'save', core: core, bytes: bytes.buffer, sha256: hash }, [bytes.buffer])
    }
    if (force && !sent) post({ type: 'unchanged' })
    if (force) post({ type: 'flushed' })
  }

  // ------------------------------------------------------------ boot and frames

  function copyIn(buffer) {
    if (!buffer) return [0, 0]
    var bytes = new Uint8Array(buffer)
    var ptr = hub._malloc(bytes.length) // kept: mGBA maps the game in place
    hub.HEAPU8.set(bytes, ptr)
    return [ptr, bytes.length]
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script')
      s.src = src
      s.onload = resolve
      s.onerror = function () { reject(new Error('Could not load the emulator.')) }
      document.head.appendChild(s)
    })
  }

  async function boot(msg) {
    if (hub || booting) return
    booting = true
    try {
      if (msg.bindings && typeof msg.bindings === 'object') {
        for (var action in msg.bindings) {
          if (action in DEFAULT_KEYS && (typeof msg.bindings[action] === 'string' || msg.bindings[action] === null)) {
            keys[action] = msg.bindings[action]
          }
        }
      }
      ds = msg.platform === 'NDS'
      if (ds) {
        if (msg.games.length !== 1) throw new Error('A DS page runs one game.')
        BITS.x = 10
        BITS.y = 11
        PAD.x = 3 // top face button
        PAD.y = 2 // left face button
        document.body.classList.add('ds')
        await loadScript('ds/melonds-hub.js')
      }
      await startAudio()
      var dir = ds ? 'ds/' : 'core/'
      hub = await (ds ? window.createMelonHub : window.createMgbaHub)({
        locateFile: function (path) {
          return dir + path
        },
      })
      cores = msg.games.length
      local = msg.local
      linked = cores > 1
      var rtc = msg.rtc && msg.rtc.mode === 'fixed' ? msg.rtc.epochMs : 0
      if (!hub._hub_init(msg.platform === 'GB' ? 1 : 0, cores, audio ? audio.rate : 48000, msg.rtc && msg.rtc.mode === 'fixed' ? 1 : 0, rtc)) {
        throw new Error('The emulator could not start.')
      }
      for (var i = 0; i < cores; i++) {
        var g = msg.games[i]
        var rom = copyIn(g.rom)
        var save = copyIn(g.save)
        var patch = copyIn(g.patch)
        if (!hub._hub_load(i, rom[0], rom[1], save[0], save[1], patch[0], patch[1])) {
          throw new Error('Game ' + (i + 1) + ' could not be loaded.')
        }
        if (save[0]) hub._free(save[0]) // copied into the core's in-memory save file
        if (patch[0]) hub._free(patch[0]) // applied at load
      }
      hub._hub_start(msg.audioFrom == null ? local[0] : msg.audioFrom)
      for (var j = 0; j < local.length; j++) {
        var initial = msg.games[local[j]].save
        if (initial) lastHash[local[j]] = await sha256(initial)
      }
      makeScreens()
      build = await fetch(dir + 'build.json').then(function (r) { return r.json() }).catch(function () { return null })
      post({ type: 'started', build: build })
      reportControls()
      setInterval(function () {
        poll(false)
      }, POLL_MS)
    } catch (e) {
      post({ type: 'error', crashed: false, message: e.message || String(e), stack: e.stack ? String(e.stack) : undefined, recent: recent.slice() })
    }
  }

  function frame(msg) {
    if (!hub || paused) return post({ type: 'framed', local: sampleLocal(), stalls: 0, skipped: true })
    var count = Math.max(1, Math.min(msg.count | 0, 8))
    var catchingUp = count > 1
    var waiting = false
    for (var n = 0; n < count; n++) {
      if (msg.inputs) {
        for (var c = 0; c < cores; c++) hub._hub_set_keys(c, msg.inputs[c] | 0)
      } else {
        var mine = sampleLocal()
        for (var l = 0; l < local.length; l++) hub._hub_set_keys(local[l], mine[l])
      }
      if (!hub._hub_run_frame()) {
        waiting = true // a GBA cable parent waits for its child; the frame is dropped, not owed
        break
      }
      framesRun++
      pushAudio(catchingUp && n < count - 1)
    }
    draw()
    var reply = {
      type: 'framed',
      local: sampleLocal(),
      stalls: hub._hub_stalls(),
    }
    if (msg.hash) reply.hash = hub._hub_hash()
    if (waiting) reply.waiting = true
    post(reply)
    if (airOn) postAir()
    if (cablePlugged) {
      var out = hub._hub_cable_take() >> 2
      for (var m = 0; m < hub.HEAPU32[out]; m++) {
        var at = out + 1 + m * 3
        post({ type: 'cable', k: hub.HEAPU32[at], b: hub.HEAPU32[at + 1], n: hub.HEAPU32[at + 2] })
      }
    }
  }

  function plugCable(on, m) {
    if (!hub || !hub._hub_cable_plug(on ? 1 : 0, m.seat | 0, m.delay | 0)) return
    cablePlugged = on
    linked = on || airRoom
    if (on) states = {} // a state loaded mid-trade could undo it
  }

  function postAir() {
    var air = hub._hub_air_take() >> 2
    var at = air + 1
    for (var a = 0; a < hub.HEAPU32[air]; a++) {
      var len = hub.HEAPU32[at + 2]
      post({ type: 'air', op: hub.HEAPU32[at], to: hub.HEAPU32[at + 1], d: Array.from(hub.HEAPU32.subarray(at + 3, at + 3 + len)) })
      at += 3 + len
    }
    traceAir()
  }

  // Real games aren't proven against the emulated adapter yet (ADR-022): when the game
  // stops it (link errors included) or it refuses a command, print what led up to it.
  var AIR_OPS = ['', 'beacon', 'beacon off', 'join', 'accept', 'reject', 'data', 'leave']
  function traceAir() {
    var t = hub._hub_air_trace() >> 2
    if (!t) return
    var hex = function (n) { return '0x' + (n >>> 0).toString(16) }
    var lines = []
    for (var i = 0, at = t + 1; i < hub.HEAPU32[t]; i++, at += 4) {
      var what = hub.HEAPU32[at + 1]
      var detail = hub.HEAPU32[at + 3]
      lines.push('frame ' + hub.HEAPU32[at] + ' state ' + hub.HEAPU32[at + 2] + ': ' +
        (what >= 0xee00 ? 'command ' + hex(what & 0xff) + ' REFUSED, code ' + detail
          : what >= 0x100 ? AIR_OPS[what - 0x100] + ' from seat ' + detail
          : what === 0x29 ? 'woke the game: disconnected ' + hex(detail)
          : 'command ' + hex(what) + ' → ' + hex(detail)))
    }
    console.warn('[wireless adapter] recent events (state 0 idle, 1–2 hosting, 3 searching, 4 connecting, 5 connected):\n' + lines.join('\n'))
  }

  function plugAir(on, m) {
    if (!hub || !hub._hub_air_plug(on ? 1 : m.quiet ? 2 : 0, m.seat | 0)) return
    if (!on) postAir() // the adapter's goodbyes to anyone it was connected to
    if (on || !m.quiet) airOn = on // quiet: still plugged in, with nobody in range
    airRoom = on
    linked = on || cablePlugged
    if (on) states = {} // a state loaded mid-trade could undo it
  }

  function putAir(m) {
    if (!airOn || !Array.isArray(m.d) || m.d.length > 24 || !Number.isInteger(m.op) || !Number.isInteger(m.from)) return
    var inbox = hub._hub_air_inbox() >> 2
    for (var i = 0; i < m.d.length; i++) hub.HEAPU32[inbox + i] = m.d[i] >>> 0
    hub._hub_air_put(m.op, m.from, m.d.length)
  }

  function setPaused(value) {
    paused = value
    if (audio) (value ? audio.ctx.suspend() : audio.ctx.resume()).catch(function () {})
  }

  window.addEventListener('keydown', function (e) {
    onKey(e, true)
  })
  window.addEventListener('keyup', function (e) {
    onKey(e, false)
  })
  window.addEventListener('blur', function () {
    held = {}
    touches = {}
    showTouches()
  })
  document.addEventListener('pointerdown', function () {
    if (screens[0]) screens[0].ctx.canvas.focus()
    if (audio) audio.ctx.resume().catch(function () {})
  })

  window.addEventListener('message', function (e) {
    if (e.origin !== origin || e.source !== parent || !e.data) return
    var m = e.data
    if (m.type === 'ping') post({ type: 'ready' })
    else if (m.type === 'boot') boot(m)
    else if (m.type === 'frame') frame(m)
    else if (m.type === 'pause') setPaused(true)
    else if (m.type === 'resume') setPaused(false)
    else if (m.type === 'flush') poll(true)
    else if (m.type === 'clear-states') states = {}
    else if (m.type === 'cable-plug') plugCable(!!m.on, m)
    else if (m.type === 'air-plug') plugAir(!!m.on, m)
    else if (m.type === 'air') putAir(m)
    else if (m.type === 'cable') {
      var valid = Number.isInteger(m.k) && m.k >= 0 && m.k <= 4 && Number.isInteger(m.b) && m.b >= 0 && m.b <= 0xffffffff
      if (cablePlugged && valid && Number.isInteger(m.n) && m.n > 0) hub._hub_cable_put(m.k, m.b, m.n)
    }
    else if (m.type === 'bind' && ACTIONS.indexOf(m.action) >= 0 && typeof m.code === 'string') {
      for (var a in keys) if (keys[a] === m.code) keys[a] = null // one action per key
      keys[m.action] = m.code
      reportControls()
    } else if (m.type === 'reset-bindings') {
      keys = Object.assign({}, DEFAULT_KEYS)
      reportControls()
    } else if (m.type === 'enable-audio') {
      window.enableHubAudio()
    } else if (m.type === 'audio-settings') {
      audioSettings.muted = !!m.muted
      if (typeof m.volume === 'number') audioSettings.volume = Math.max(0, Math.min(1, m.volume))
      try { localStorage.setItem(AUDIO_STORAGE_KEY, JSON.stringify(audioSettings)) } catch (e) { /* in-memory only */ }
      reportControls()
    }
  })

  post({ type: 'ready' })
})()
