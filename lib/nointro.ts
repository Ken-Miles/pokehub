/**
 * Minimal No-Intro DAT reader. DATs are XML, but we only need <game name> and
 * its <rom … /> attributes, so this scans tags directly — no XML parser, no
 * entity expansion, nothing fetched.
 */

export interface DatRom {
  game: string
  name: string
  size: number
  sha1: string
  crc: string
  serial: string
}

export interface Dat {
  name: string
  version: string
  roms: DatRom[]
}

const attrs = (tag: string): Record<string, string> =>
  Object.fromEntries([...tag.matchAll(/([a-z0-9_]+)="([^"]*)"/gi)].map((m) => [m[1], decodeEntities(m[2])]))

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e as string]!)
}

export function parseDat(xml: string): Dat {
  const header = xml.match(/<header>([\s\S]*?)<\/header>/)?.[1] ?? ''
  const name = header.match(/<name>([^<]*)<\/name>/)?.[1] ?? ''
  const version = header.match(/<version>([^<]*)<\/version>/)?.[1] ?? ''
  const roms: DatRom[] = []
  for (const g of xml.matchAll(/<game\s([^>]*)>([\s\S]*?)<\/game>/g)) {
    const game = attrs(g[1]).name ?? ''
    for (const r of g[2].matchAll(/<rom\s([^>]*?)\/?>/g)) {
      const a = attrs(r[1])
      if (!a.sha1) continue
      roms.push({
        game,
        name: a.name ?? '',
        size: Number(a.size ?? 0),
        sha1: a.sha1.toLowerCase(),
        crc: (a.crc ?? '').toLowerCase(),
        serial: a.serial ?? '',
      })
    }
  }
  return { name: decodeEntities(name), version, roms }
}

/**
 * Dumps we never accept even though they're in No-Intro: bootlegs, store kiosk
 * and event carts, debug/prototype/demo builds, and the Nintendo Switch Online
 * re-releases (patched builds; not cartridge games).
 */
export const EXCLUDED_DUMP = /\((Pirate|Kiosk|Debug|Debug Version|Proto|Demo|Beta|Switch)\)/i
