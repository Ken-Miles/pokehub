/**
 * Spot a game file (or a slice of one) by its header, so it is refused before it
 * is sent or stored (NFR-01). Pure and framework-free: used in the browser and
 * on the server.
 */

/**
 * A real GBA header: branch opcode at 0x03, fixed byte 0x96 at 0xB2 and a
 * matching header checksum at 0xBD. Random save data passes all three about
 * once in 10^10, so real saves aren't refused.
 */
export function hasGbaRomHeader(b: Uint8Array): boolean {
  if (b.length < 0xc0 || b[0x03] !== 0xea || b[0xb2] !== 0x96) return false
  let chk = 0
  for (let i = 0xa0; i <= 0xbc; i++) chk = (chk - b[i]) & 0xff
  return ((chk - 0x19) & 0xff) === b[0xbd]
}

/**
 * A real Game Boy header: the first four bytes of the Nintendo logo at 0x104
 * and a matching header checksum at 0x14D. Random data passes about once in 10^12.
 */
export function hasGbRomHeader(b: Uint8Array): boolean {
  if (b.length < 0x150 || b[0x104] !== 0xce || b[0x105] !== 0xed || b[0x106] !== 0x66 || b[0x107] !== 0x66) return false
  let chk = 0
  for (let i = 0x134; i <= 0x14c; i++) chk = (chk - b[i] - 1) & 0xff
  return chk === b[0x14d]
}

/**
 * A real DS header: the Nintendo logo's fixed CRC (0xCF56) at 0x15C and a
 * matching CRC-16 of the header's first 0x15E bytes at 0x15E. Random data
 * passes both about once in 4 × 10^9.
 */
export function hasNdsRomHeader(b: Uint8Array): boolean {
  if (b.length < 0x160 || b[0x15c] !== 0x56 || b[0x15d] !== 0xcf) return false
  return crc16(b.subarray(0, 0x15e)) === (b[0x15e] | (b[0x15f] << 8))
}

/** CRC-16/MODBUS, the one the DS header uses. */
export function crc16(bytes: Uint8Array): number {
  let crc = 0xffff
  for (const byte of bytes) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1
  }
  return crc
}
