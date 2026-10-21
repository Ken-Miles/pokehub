/**
 * The on-screen controls legend (FR-06), built from the bindings the emulator
 * page reports (public/emulator/player.js → { type: 'controls' }). Remaps made
 * in the legend show up here as soon as the emulator stores them.
 */

export type Action = 'a' | 'b' | 'l' | 'r' | 'start' | 'select' | 'up' | 'down' | 'left' | 'right' | 'save' | 'load' | 'slot'

export interface Binding {
  id: Action
  key: string | null // KeyboardEvent.code, e.g. "KeyZ", "ArrowUp"
  pad: string | null // gamepad button, e.g. "BUTTON_1", "DPAD_UP"
}

export interface LegendRow {
  id: Action
  action: string
  key: string
  pad: string | null
}

// GBA buttons first, then the hotkeys, in the order a player looks for them.
const ACTIONS: [Action, string][] = [
  ['a', 'A'],
  ['b', 'B'],
  ['l', 'L'],
  ['r', 'R'],
  ['start', 'Start'],
  ['select', 'Select'],
  ['up', 'Up'],
  ['down', 'Down'],
  ['left', 'Left'],
  ['right', 'Right'],
  ['save', 'Quick save state'],
  ['load', 'Quick load state'],
  ['slot', 'Next state slot'],
]

const HOTKEYS = new Set<Action>(['save', 'load', 'slot'])
/** Hotkeys that don't apply while linked (lockstep has one speed and no states). */
export const SOLO_ONLY = HOTKEYS

const KEY_NAMES: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: 'Enter',
  Space: 'Space',
  ShiftLeft: 'Left Shift',
  ShiftRight: 'Right Shift',
  ControlLeft: 'Left Ctrl',
  ControlRight: 'Right Ctrl',
  AltLeft: 'Left Alt',
  AltRight: 'Right Alt',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
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

export function keyLabel(code: string | null): string {
  if (!code) return 'Not set'
  if (KEY_NAMES[code]) return KEY_NAMES[code]
  const m = /^(?:Key|Digit|Numpad)(.+)$/.exec(code)
  if (m) return code.startsWith('Numpad') ? `Numpad ${m[1]}` : m[1]
  return code
}

/** Keys the browser or the page needs; the remap refuses them. */
export function canBind(code: string): boolean {
  return !['Escape', 'F5', 'F11', 'F12', 'MetaLeft', 'MetaRight', 'Tab'].includes(code)
}

export function legend(bindings: Binding[], opts: { linked?: boolean } = {}): LegendRow[] {
  const byId = new Map(bindings.map((b) => [b.id, b]))
  return ACTIONS.flatMap(([id, action]) => {
    const b = byId.get(id)
    if (opts.linked && SOLO_ONLY.has(id)) return []
    // An unbound hotkey isn't worth a row; an unbound game button is (the player needs to fix it).
    if (!b?.key && !b?.pad && HOTKEYS.has(id)) return []
    return [{ id, action, key: keyLabel(b?.key ?? null), pad: b?.pad ? (PAD_NAMES[b.pad] ?? b.pad) : null }]
  })
}
