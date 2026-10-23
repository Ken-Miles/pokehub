#!/usr/bin/env python3 -I
"""
Writes two 32 KB homebrew Game Boy test programs for the network cable
(tests/emulator-core.test.ts). Our own hand-assembled code, no game data.
Same code, two headers:
  link-test.gb      plain Game Boy cart (runs like Gen 1)
  link-test-gbc.gb  Game Boy Color cart with MBC3 + clock + 32 KB battery RAM (like Gen 2)
Holding A at power-on picks side 1. The program first writes 0x5A to cart RAM
(nothing there on the plain cart), then:
  1. both sides clock at once: side 0 sends 0x11, side 1 sends 0x22
  2. 16 rounds: side 0 clocks 0x40+n, side 1 waits with 0xC0+n
Results in work RAM: C000 side, C001 byte from step 1, C002 rounds done,
C003..C012 bytes received per round.
Run: python3 tests/fixtures/link-rom/build-gb.py
"""
import os

LOGO = bytes.fromhex(  # the boot ROM checks these 48 bytes; every GB program carries them
    'CEED6666CC0D000B03730083000C000D0008111F8889000EDCCC6EE6DDDDD999'
    'BBBB67636E0EECCCDDDC999FBBB9333E')

prog = [  # SM83 at 0x150; ('jr', label) / ('call', label) are fixed up below
    'F3', '31FEFF',        # di; ld sp,$FFFE
    '3E0A', 'EA0000', '3E5A', 'EA00A0',  # enable cart RAM; ld [$A000],$5A
    '3E10', 'E000',        # ld a,$10; ldh [JOYP],a   (read the buttons)
    'F000', '2F', 'E601',  # ldh a,[JOYP]; cpl; and 1 (1 = A held)
    'EA00C0', '57',        # ld [$C000],a; ld d,a     (d = side)
    '7A', '3C', '47', 'CB37', 'B0',  # a = (side+1) * $11
    'E001', '3E81', 'E002',          # ldh [SB],a; ld a,$81; ldh [SC],a (clock)
    ('call', 'wait'),
    'F001', 'EA01C0',      # ldh a,[SB]; ld [$C001],a
    '7A', '0F', 'C640', '5F',  # e = side ? $C0 : $40
    '3E81', '92', '47',        # b = side ? $80 (wait) : $81 (clock)
    '2103C0', '0E00',          # ld hl,$C003; ld c,0
    'loop:',
    '79', 'FE10', ('jr', '28', 'done'),  # ld a,c; cp 16; jr z,done
    '83', 'E001', '78', 'E002',          # add e; ldh [SB],a; ld a,b; ldh [SC],a
    ('call', 'wait'),
    'F001', '22', '0C', '79', 'EA02C0',  # ldh a,[SB]; ld [hl+],a; inc c; ld a,c; ld [$C002],a
    ('jr', '18', 'loop'),
    'done:', ('jr', '18', 'done'),
    'wait:', 'F002', 'CB7F', ('jr', '20', 'wait'), 'C9',  # until SC bit 7 clears; ret
]


def assemble(items, origin):
    labels, pc = {}, origin
    for it in items:
        if isinstance(it, str) and it.endswith(':'):
            labels[it[:-1]] = pc
        else:
            pc += 3 if isinstance(it, tuple) and it[0] == 'call' else 2 if isinstance(it, tuple) else len(it) // 2
    out, pc = bytearray(), origin
    for it in items:
        if isinstance(it, str) and it.endswith(':'):
            continue
        if isinstance(it, tuple) and it[0] == 'call':
            out += bytes([0xCD]) + labels[it[1]].to_bytes(2, 'little')
        elif isinstance(it, tuple):
            offset = labels[it[2]] - (pc + 2)
            assert -128 <= offset < 128
            out += bytes([int(it[1], 16), offset & 0xFF])
        else:
            out += bytes.fromhex(it)
        pc = origin + len(out)
    return out


def build(name, cgb, cart, ram):
    rom = bytearray(0x8000)
    rom[0x100:0x104] = bytes.fromhex('00C35001')  # nop; jp $0150
    rom[0x104:0x134] = LOGO
    rom[0x134:0x143] = b'HUBLINKTEST'.ljust(15, b'\0')
    rom[0x143] = cgb  # 0x80: Game Boy Color features, still runs on a Game Boy
    rom[0x147] = cart
    rom[0x149] = ram
    rom[0x14A] = 0x01  # destination: international; ROM size 0 = 32 KB
    check = 0
    for b in rom[0x134:0x14D]:
        check = (check - b - 1) & 0xFF
    rom[0x14D] = check
    code = assemble(prog, 0x150)
    rom[0x150:0x150 + len(code)] = code
    total = sum(rom) - rom[0x14E] - rom[0x14F]
    rom[0x14E:0x150] = (total & 0xFFFF).to_bytes(2, 'big')
    open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', name), 'wb').write(rom)
    print('wrote tests/fixtures/' + name)


build('link-test.gb', 0x00, 0x00, 0x00)
build('link-test-gbc.gb', 0x80, 0x10, 0x03)  # MBC3+TIMER+RAM+BATTERY, 32 KB RAM
