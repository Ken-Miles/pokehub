import { canBind, keyLabel, legend, type Binding } from '@/lib/client/controls'

/** FR-06: the on-screen legend shows the player's current bindings. */
const defaults: Binding[] = [
  { id: 'a', key: 'KeyX', pad: 'BUTTON_2' },
  { id: 'b', key: 'KeyZ', pad: 'BUTTON_1' },
  { id: 'l', key: 'KeyA', pad: 'LEFT_TOP_SHOULDER' },
  { id: 'r', key: 'KeyS', pad: 'RIGHT_TOP_SHOULDER' },
  { id: 'start', key: 'Enter', pad: 'START' },
  { id: 'select', key: 'Backspace', pad: 'SELECT' },
  { id: 'up', key: 'ArrowUp', pad: 'DPAD_UP' },
  { id: 'down', key: 'ArrowDown', pad: 'DPAD_DOWN' },
  { id: 'left', key: 'ArrowLeft', pad: 'DPAD_LEFT' },
  { id: 'right', key: 'ArrowRight', pad: 'DPAD_RIGHT' },
  { id: 'save', key: 'F2', pad: null },
  { id: 'load', key: 'F4', pad: null },
  { id: 'slot', key: 'F3', pad: null },
]

describe('legend', () => {
  it('lists GBA buttons then hotkeys, with readable names', () => {
    const rows = legend(defaults)
    expect(rows.map((r) => r.action)).toEqual([
      'A', 'B', 'L', 'R', 'Start', 'Select', 'Up', 'Down', 'Left', 'Right',
      'Quick save state', 'Quick load state', 'Next state slot',
    ])
    expect(rows[0]).toEqual({ id: 'a', action: 'A', key: 'X', pad: 'Right face button' })
    expect(rows.find((r) => r.action === 'Up')?.key).toBe('↑')
    expect(rows.find((r) => r.action === 'Start')?.key).toBe('Enter')
  })

  it('shows a remapped game key', () => {
    const remapped = defaults.map((b) => (b.id === 'a' ? { ...b, key: 'KeyK' } : b))
    const rows = legend(remapped)
    expect(rows[0].key).toBe('K')
  })

  it('flags an unbound game button instead of hiding it', () => {
    const rows = legend(defaults.map((b) => (b.id === 'b' ? { ...b, key: null, pad: null } : b)))
    expect(rows.find((r) => r.action === 'B')).toEqual({ id: 'b', action: 'B', key: 'Not set', pad: null })
  })

  it('hides save states while linked (lockstep has neither)', () => {
    const rows = legend(defaults, { linked: true })
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'l', 'r', 'start', 'select', 'up', 'down', 'left', 'right'])
  })

  it('names keys by code, and keeps unknown codes as they are', () => {
    expect(keyLabel('Digit1')).toBe('1')
    expect(keyLabel('Numpad5')).toBe('Numpad 5')
    expect(keyLabel('ShiftLeft')).toBe('Left Shift')
    expect(keyLabel('IntlRo')).toBe('IntlRo')
    expect(keyLabel(null)).toBe('Not set')
  })

  it("won't bind keys the browser needs", () => {
    expect(canBind('Escape')).toBe(false)
    expect(canBind('F5')).toBe(false)
    expect(canBind('KeyQ')).toBe(true)
  })
})
