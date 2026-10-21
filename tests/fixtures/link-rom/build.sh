#!/bin/sh
# Assembles link-test.s into tests/fixtures/link-test.gba (a 1 KB homebrew test
# program, not a game). Needs a clang with the ARM backend (Apple's has one).
# No linker: everything is PC-relative, so the object's .text is the program.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
clang -target armv4t-none-eabi -c "$here/link-test.s" -o "$tmp/link-test.o"
python3 -I - "$tmp/link-test.o" "$here/../link-test.gba" <<'EOF'
import struct, sys
elf = open(sys.argv[1], 'rb').read()
shoff, = struct.unpack_from('<I', elf, 0x20)
shentsize, shnum, shstrndx = struct.unpack_from('<HHH', elf, 0x2e)
sections = [struct.unpack_from('<IIIIIIIIII', elf, shoff + i * shentsize) for i in range(shnum)]
names = sections[shstrndx]
def name(s):
    start = names[4] + s[0]
    return elf[start:elf.index(b'\0', start)].decode()
text = next(s for s in sections if name(s) == '.text')
code = elf[text[4]:text[4] + text[5]]
open(sys.argv[2], 'wb').write(code.ljust(1024, b'\0'))
EOF
echo "wrote tests/fixtures/link-test.gba"
