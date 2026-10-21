/**
 * The on-screen controls legend (FR-06), built from the bindings the emulator
 * bridge reports (public/emulator/player.js → { type: 'controls' }). Remaps made
 * in EmulatorJS's Control Settings show up here as soon as they are saved.
 */

export interface Binding {
  id: number // EmulatorJS control id
  key: string | null // keyboard key name, e.g. "z", "up arrow"
  pad: string | null // gamepad button, e.g. "BUTTON_1", "DPAD_UP"
}

export interface LegendRow {
  action: string
  key: string
  pad: string | null
}

// GBA buttons first, then the hotkeys, in the order a player looks for them.
const ACTIONS: [number, string][] = [
  [8, 'A'],
  [0, 'B'],
  [10, 'L'],
  [11, 'R'],
  [3, 'Start'],
  [2, 'Select'],
  [4, 'Up'],
  [5, 'Down'],
  [6, 'Left'],
  [7, 'Right'],
  [27, 'Fast-forward (hold)'],
  [24, 'Quick save state'],
  [25, 'Quick load state'],
  [26, 'Next state slot'],
]

const KEY_NAMES: Record<string, string> = {
  'up arrow': '↑',
  'down arrow': '↓',
  'left arrow': '←',
  'right arrow': '→',
  enter: 'Enter',
  space: 'Space',
  shift: 'Shift',
  tab: 'Tab',
  backspace: 'Backspace',
}

const PAD_NAMES: Record<string, string> = {
  BUTTON_1: 'Bottom face button',
  BUTTON_2: 'Right face button',
  BUTTON_3: 'Left face button',
  BUTTON_4: 'Top face button',
  LEFT_TOP_SHOULDER: 'Left bumper',
  RIGHT_TOP_SHOULDER: 'Right bumper',
  SELECT: 'Select / Back',
  START: 'Start / Menu',
  DPAD_UP: 'D-pad up',
  DPAD_DOWN: 'D-pad down',
  DPAD_LEFT: 'D-pad left',
  DPAD_RIGHT: 'D-pad right',
}

export function keyLabel(key: string | null): string {
  if (!key) return 'Not set'
  return KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key)
}

export function legend(bindings: Binding[]): LegendRow[] {
  const byId = new Map(bindings.map((b) => [b.id, b]))
  return ACTIONS.flatMap(([id, action]) => {
    const b = byId.get(id)
    // An unbound hotkey isn't worth a row; an unbound game button is (the player needs to fix it).
    if (!b?.key && !b?.pad && id >= 24) return []
    return [{ action, key: keyLabel(b?.key ?? null), pad: b?.pad ? (PAD_NAMES[b.pad] ?? b.pad) : null }]
  })
}
