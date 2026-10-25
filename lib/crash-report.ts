import { z } from 'zod'

/**
 * What the browser sends when the emulator crashes: text about the crash only,
 * never game or save bytes (NFR-01). Lengths are capped so a report can't flood the logs.
 */
export const crashReport = z.object({
  /** 'solo' (a slot's Player) or 'link' (a link session). */
  where: z.enum(['solo', 'link']),
  /** The slot or link session id. */
  id: z.string().max(64),
  message: z.string().max(1000),
  stack: z.string().max(4000).optional(),
  /** true = died while running; false = refused to boot. */
  crashed: z.boolean(),
  frames: z.number().int().nonnegative().optional(),
  linked: z.boolean().optional(),
  /** core/build.json */
  build: z.record(z.string(), z.string().max(100)).nullable().optional(),
  /** The iframe's last console warnings/errors, oldest first. */
  recent: z.array(z.string().max(500)).max(20).optional(),
  userAgent: z.string().max(300).optional(),
})

export type CrashReport = z.infer<typeof crashReport>
