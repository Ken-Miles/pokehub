import type { Role } from '@prisma/client'

/**
 * Role ordering and checks (Stork v2 pattern). Roles come from the database on
 * every request (lib/session.ts), so a demotion takes effect immediately.
 */
const RANK: Record<Role, number> = { PLAYER: 0, MOD: 1, ADMIN: 2, OWNER: 3 }

export function roleAtLeast(role: string, min: Role): boolean {
  return (RANK[role as Role] ?? 0) >= RANK[min]
}

/** Can reach /admin: the audit log (FR-24) and slot recovery (FR-10). */
export function isAdmin(role: string): boolean {
  return roleAtLeast(role, 'ADMIN')
}
