#!/bin/sh
# Assembles link-test.s, net-test.s and rfu-test.s into tests/fixtures/*.gba (homebrew
# test programs, not games). Needs a clang with the ARM backend (Apple's has one).
# No linker: everything is PC-relative, so the object's .text is the program.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for name in link-test net-test rfu-test; do
clang -target armv4t-none-eabi -c "$here/$name.s" -o "$tmp/$name.o"
python3 -I - "$tmp/$name.o" "$here/../$name.gba" <<'EOF'
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
echo "wrote tests/fixtures/$name.gba"
done
