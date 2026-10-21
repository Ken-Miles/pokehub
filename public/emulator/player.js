/*
 * Glue between Pokémon Hub and EmulatorJS (ADR-009).
 *
 * parent → iframe   { type: 'boot', rom: ArrayBuffer, save: ArrayBuffer|null, core: 'gba', data: url }
 *                   { type: 'pause' } | { type: 'resume' }
 *                   { type: 'flush' } — "Sync now": read save RAM immediately
 *                   { type: 'clear-states' } — the cloud save changed elsewhere (FR-06)
 *                   { type: 'fast-forward', on: boolean }
 * iframe → parent   { type: 'ready' } | { type: 'started' }
 *                   { type: 'save', bytes: ArrayBuffer, sha256: string }
 *                   { type: 'unchanged' } — answer to a flush with nothing new
 *                   { type: 'controls', keys: [{ id, key, pad }], fastForward: boolean }
 *
 * The game file arrives as bytes from the parent page and never leaves the browser.
 * EmulatorJS has no reliable "game saved" event, so save RAM is polled and hashed.
 *
 * Save states (FR-06, ADR-016) live only in the emulator's in-memory file system: quick
 * slots 1–9, which the Save/Load State buttons are pointed at too, so nothing is
 * downloaded or kept in browser storage. A reload clears them, and the parent
 * sends clear-states when the cloud save changes elsewhere (trade, restore), so
 * no state from before that change can be loaded and saved over it.
 */
(function () {
  'use strict'

  var POLL_MS = 2000
  var STATE_SLOTS = 9
  // GBA buttons and the hotkeys the page lists (EmulatorJS control ids).
  var CONTROL_IDS = [8, 0, 10, 11, 3, 2, 4, 5, 6, 7, 24, 25, 26, 27]
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

  // `force` (Sync now) skips the two-poll debounce: the player asked for it.
  async function poll(force) {
    var g = gm()
    if (!g || paused) {
      if (force) post({ type: 'unchanged' })
      return
    }
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
      if (force) post({ type: 'unchanged' })
      return
    }
    // Debounce: only report once two polls agree, so a save in progress isn't sent half-written.
    if (!force && hash !== pendingHash) {
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

  function stateSlot() {
    var v = emu().getSettingValue && emu().getSettingValue('save-state-slot')
    return v || '1'
  }

  // The Save/Load State buttons would download a .state file (which could be
  // loaded again after a trade); answer their events so they use the in-memory
  // slot instead. EmulatorJS skips its own handling when a listener exists.
  function keepStatesInMemory() {
    var e = emu()
    e.on('saveState', function () {
      var slot = stateSlot()
      e.displayMessage(gm().quickSave(slot) ? 'Saved state to slot ' + slot + ' (this tab only)' : 'Failed to save state')
    })
    e.on('loadState', function () {
      var slot = stateSlot()
      if (!gm().FS.analyzePath('/' + slot + '-quick.state').exists) return e.displayMessage('No state in slot ' + slot)
      gm().quickLoad(slot)
      e.displayMessage('Loaded state from slot ' + slot)
    })
  }

  function clearStates() {
    var g = gm()
    if (!g) return
    for (var i = 1; i <= STATE_SLOTS; i++) {
      try {
        g.FS.unlink('/' + i + '-quick.state')
      } catch (err) {
        /* slot was empty */
      }
    }
  }

  // Current key and gamepad bindings, including the player's remaps.
  function reportControls() {
    var e = emu()
    if (!e || !e.controls) return
    var keys = CONTROL_IDS.map(function (id) {
      var c = e.controls[0] && e.controls[0][id]
      var code = c && c.value
      return { id: id, key: code ? e.keyMap[code] || String(code) : null, pad: (c && c.value2) || null }
    })
    post({ type: 'controls', keys: keys, fastForward: !!e.isFastForward })
  }

  function setFastForward(on) {
    var e = emu()
    if (!e || !e.changeSettingOption) return
    var value = on ? 'enabled' : 'disabled'
    e.changeSettingOption('fastForward', value)
    e.menuOptionChanged('fastForward', value)
    reportControls()
  }

  // Hiding the Cheats button isn't enough: EmulatorJS restores cheats saved in
  // localStorage and re-applies them when it builds its menu. Drop them and stub
  // the hook. Only a deterrent — anyone with devtools can still poke the core,
  // so the server-side legality and registry checks remain the real defence.
  function disableCheats() {
    var e = emu()
    if (!e) return
    e.cheats = []
    e.cheatChanged = function () {}
    if (gm() && typeof gm().resetCheat === 'function') gm().resetCheat()
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
    window.EJS_hideSettings = ['save-state-location'] // states are always in-memory here
    // Cloud saves replace EmulatorJS's own save import/export; netplay is out of scope.
    window.EJS_Buttons = { saveSavFiles: false, loadSavFiles: false, cacheManager: false, netplay: false, cheat: false }
    window.EJS_onGameStart = async function () {
      disableCheats()
      keepStatesInMemory()
      // Remaps and menu toggles all go through saveSettings; report after each.
      var saveSettings = emu().saveSettings.bind(emu())
      emu().saveSettings = function () {
        saveSettings()
        reportControls()
      }
      if (msg.save) {
        var save = new Uint8Array(msg.save)
        writeSave(save)
        lastHash = await sha256(save)
        gm().restart() // boot again so the game reads the cloud save from the start
      }
      post({ type: 'started' })
      reportControls()
      setInterval(function () {
        poll(false)
      }, POLL_MS)
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
    else if (e.data.type === 'flush') poll(true)
    else if (e.data.type === 'clear-states') clearStates()
    else if (e.data.type === 'fast-forward') setFastForward(!!e.data.on)
  })

  post({ type: 'ready' })
})()
