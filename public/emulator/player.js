/*
 * Glue between Pokémon Hub and EmulatorJS (ADR-009).
 *
 * parent → iframe   { type: 'boot', rom: ArrayBuffer, save: ArrayBuffer|null, core: 'gba', data: url }
 *                   { type: 'pause' } | { type: 'resume' }
 * iframe → parent   { type: 'ready' } | { type: 'started' }
 *                   { type: 'save', bytes: ArrayBuffer, sha256: string }
 *
 * The game file arrives as bytes from the parent page and never leaves the browser.
 * EmulatorJS has no reliable "game saved" event, so save RAM is polled and hashed.
 */
(function () {
  'use strict'

  var POLL_MS = 2000
  var origin = location.origin
  var lastHash = null // hash of the save the server already has
  var pendingHash = null // seen once; reported when the next poll agrees
  var paused = false
  var booted = false

  function post(msg, transfer) {
    parent.postMessage(msg, origin, transfer || [])
  }

  function emu() {
    return window.EJS_emulator
  }

  function gm() {
    return emu() && emu().gameManager
  }

  async function sha256(bytes) {
    var digest = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest), function (b) {
      return b.toString(16).padStart(2, '0')
    }).join('')
  }

  // Same steps as EmulatorJS's own "load save file" button.
  function writeSave(bytes) {
    var g = gm()
    var path = g.getSaveFilePath()
    var parts = path.split('/')
    var dir = ''
    for (var i = 0; i < parts.length - 1; i++) {
      if (!parts[i]) continue
      dir += '/' + parts[i]
      if (!g.FS.analyzePath(dir).exists) g.FS.mkdir(dir)
    }
    if (g.FS.analyzePath(path).exists) g.FS.unlink(path)
    g.FS.writeFile(path, bytes)
    g.loadSaveFiles()
  }

  async function poll() {
    var g = gm()
    if (!g || paused) return
    var bytes
    try {
      bytes = g.getSaveFile() // flushes save RAM to the virtual FS, then reads it
    } catch (e) {
      return
    }
    if (!bytes || !bytes.length) return
    var hash = await sha256(bytes)
    if (hash === lastHash) {
      pendingHash = null
      return
    }
    // Debounce: only report once two polls agree, so a save in progress isn't sent half-written.
    if (hash !== pendingHash) {
      pendingHash = hash
      return
    }
    lastHash = hash
    pendingHash = null
    var copy = bytes.slice().buffer
    post({ type: 'save', bytes: copy, sha256: hash }, [copy])
  }

  function setPaused(value) {
    paused = value
    var e = emu()
    if (e && typeof e.togglePlaying === 'function' && e.paused !== value) e.togglePlaying()
  }

  function boot(msg) {
    if (booted) return
    booted = true
    window.EJS_player = '#game'
    window.EJS_core = msg.core
    window.EJS_pathtodata = msg.data
    window.EJS_gameUrl = new Blob([msg.rom])
    window.EJS_gameName = 'game'
    window.EJS_startOnLoaded = true
    window.EJS_disableDatabases = true // no second copy of saves or the game in IndexedDB
    // Cloud saves replace EmulatorJS's own save import/export; netplay is out of scope.
    window.EJS_Buttons = { saveSavFiles: false, loadSavFiles: false, cacheManager: false, netplay: false }
    window.EJS_onGameStart = async function () {
      if (msg.save) {
        var save = new Uint8Array(msg.save)
        writeSave(save)
        lastHash = await sha256(save)
        gm().restart() // boot again so the game reads the cloud save from the start
      }
      post({ type: 'started' })
      setInterval(poll, POLL_MS)
    }
    var script = document.createElement('script')
    script.src = msg.data + 'loader.js'
    document.body.appendChild(script)
  }

  window.addEventListener('message', function (e) {
    if (e.origin !== origin || !e.data) return
    if (e.data.type === 'boot') boot(e.data)
    else if (e.data.type === 'pause') setPaused(true)
    else if (e.data.type === 'resume') setPaused(false)
  })

  post({ type: 'ready' })
})()
