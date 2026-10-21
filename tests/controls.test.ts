import { keyLabel, legend, type Binding } from '@/lib/client/controls'

/** FR-06: the on-screen legend shows the player's current bindings. */
const defaults: Binding[] = [
  { id: 8, key: 'z', pad: 'BUTTON_1' },
  { id: 0, key: 'x', pad: 'BUTTON_2' },
  { id: 10, key: 'q', pad: 'LEFT_TOP_SHOULDER' },
  { id: 11, key: 'e', pad: 'RIGHT_TOP_SHOULDER' },
  { id: 3, key: 'enter', pad: 'START' },
  { id: 2, key: 'v', pad: 'SELECT' },
  { id: 4, key: 'up arrow', pad: 'DPAD_UP' },
  { id: 5, key: 'down arrow', pad: 'DPAD_DOWN' },
  { id: 6, key: 'left arrow', pad: 'DPAD_LEFT' },
  { id: 7, key: 'right arrow', pad: 'DPAD_RIGHT' },
  { id: 24, key: '1', pad: null },
  { id: 25, key: '2', pad: null },
  { id: 26, key: '3', pad: null },
  { id: 27, key: null, pad: null },
]

describe('legend', () => {
  it('lists GBA buttons then hotkeys, with readable names', () => {
    const rows = legend(defaults)
    expect(rows.map((r) => r.action)).toEqual([
      'A', 'B', 'L', 'R', 'Start', 'Select', 'Up', 'Down', 'Left', 'Right',
      'Quick save state', 'Quick load state', 'Next state slot',
    ])
    expect(rows[0]).toEqual({ action: 'A', key: 'Z', pad: 'Bottom face button' })
    expect(rows.find((r) => r.action === 'Up')?.key).toBe('↑')
    expect(rows.find((r) => r.action === 'Start')?.key).toBe('Enter')
  })

  it('shows a remap and a newly bound fast-forward key', () => {
    const remapped = defaults.map((b) => (b.id === 8 ? { ...b, key: 'k' } : b.id === 27 ? { ...b, key: 'space' } : b))
    const rows = legend(remapped)
    expect(rows[0].key).toBe('K')
    expect(rows.find((r) => r.action === 'Fast-forward (hold)')?.key).toBe('Space')
  })

  it('flags an unbound game button instead of hiding it', () => {
    const rows = legend(defaults.map((b) => (b.id === 0 ? { ...b, key: null, pad: null } : b)))
    expect(rows.find((r) => r.action === 'B')).toEqual({ action: 'B', key: 'Not set', pad: null })
  })

  it('keeps unknown names as they are', () => {
    expect(keyLabel('numpad 5')).toBe('numpad 5')
    expect(keyLabel(null)).toBe('Not set')
  })
})
