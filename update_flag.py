"""Unlock FR/LG <-> RSE linking in a FireRed/LeafGreen .sav (offsets from pret/pokefirered).

Sets National Dex (flag 0x840, var 0x404E=0x6258, SaveBlock2 nationalMagic=0xB9)
and FLAG_SYS_CAN_LINK_WITH_RS (0x844) in the newest save slot, then fixes checksums.
usage: python3 -I frlg_link_unlock.py in.sav out.sav [--dry-run]
"""
import struct, sys

SECTOR, DATA = 0x1000, 3968
SIG = 0x08012025
SB1_FLAGS, SB1_VARS = 0x0EE0, 0x1000

def checksum(b):
    s = sum(struct.unpack_from(f"<{len(b)//4}I", b)) & 0xFFFFFFFF
    return ((s >> 16) + s) & 0xFFFF

def slot_sectors(sav, slot):
    """sector id -> file offset, plus save counter, for one 14-sector slot."""
    out, counter = {}, None
    for i in range(14):
        off = (slot * 14 + i) * SECTOR
        sid, _, sig, cnt = struct.unpack_from("<HHII", sav, off + 0xFF4)
        if sig != SIG: return None, -1
        out[sid], counter = off, cnt
    return (out, counter) if len(out) == 14 else (None, -1)

def checked_len(sav, off):
    """Length the stored checksum covers: largest multiple of 4 that matches (chunk size)."""
    stored = struct.unpack_from("<H", sav, off + 0xFF6)[0]
    for n in range(DATA, 0, -4):
        if checksum(sav[off:off + n]) == stored: return n
    sys.exit(f"checksum mismatch at sector 0x{off:x}; save corrupt or not FR/LG")

def main():
    src, dst = sys.argv[1], sys.argv[2]
    dry = "--dry-run" in sys.argv
    sav = bytearray(open(src, "rb").read())
    assert len(sav) >= 0x1C000, "not a 128KB GBA flash save"
    slots = [slot_sectors(sav, s) for s in (0, 1)]
    sectors, counter = max(slots, key=lambda x: x[1])
    assert sectors, "no valid save slot"
    lens = {sid: checked_len(sav, off) for sid, off in sectors.items()}

    def sb1(addr):  # SaveBlock1 address -> file offset (SB1 spans sectors 1..4)
        return sectors[1 + addr // DATA] + addr % DATA

    def flag(n): return sb1(SB1_FLAGS + n // 8), 1 << (n % 8)
    def get(n): o, m = flag(n); return bool(sav[o] & m)

    var_off = sb1(SB1_VARS + (0x404E - 0x4000) * 2)
    magic_off = sectors[0] + 0x18 + 3
    print(f"slot counter {counter}")
    print(f"game clear (0x82C): {get(0x82C)}  national dex flag: {get(0x840)}  "
          f"var 0x404E: 0x{struct.unpack_from('<H', sav, var_off)[0]:04x}  "
          f"magic: 0x{sav[magic_off]:02x}  can link RS (0x844): {get(0x844)}")
    if dry: return

    for n in (0x840, 0x844):
        o, m = flag(n); sav[o] |= m
    struct.pack_into("<H", sav, var_off, 0x6258)
    sav[magic_off] = 0xB9
    for sid, off in sectors.items():
        struct.pack_into("<H", sav, off + 0xFF6, checksum(sav[off:off + lens[sid]]))
    open(dst, "wb").write(sav)
    print(f"wrote {dst}")

if __name__ == "__main__":
    main()
