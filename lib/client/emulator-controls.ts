'use client'

import { api } from '@/lib/client/api'
import type { Action, Binding } from '@/lib/client/controls'

export type SavedEmulatorBindings = Partial<Record<Action, string | null>>

export async function loadEmulatorBindings(): Promise<SavedEmulatorBindings> {
  const result = await api<{ bindings: SavedEmulatorBindings }>('/api/account/controls', { cache: 'no-store' })
  return result.bindings
}

export async function saveEmulatorBindings(bindings: Binding[]): Promise<void> {
  const map = Object.fromEntries(bindings.map(({ id, key }) => [id, key])) as SavedEmulatorBindings
  await api('/api/account/controls', { method: 'PUT', body: JSON.stringify({ bindings: map }) })
}
