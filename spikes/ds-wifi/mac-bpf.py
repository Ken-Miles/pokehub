"""FR-38 Mac bridge, root half (mac-bridge.mts starts it with sudo): a feth0<->feth1 pair for
desktop melonDS (Direct mode on feth0), and raw frames on feth1 over stdin/stdout as
2-byte big-endian length + Ethernet frame. Stdlib only. macOS only (feth, BPF).
"""
import fcntl
import os
import struct
import subprocess
import sys
import threading

IF, PEER = 'feth1', 'feth0'
# <net/bpf.h> ioctls: _IOR/_IOW('B', n, u_int) and _IOW('B', 108, struct ifreq) (32 bytes).
BIOCGBLEN, BIOCPROMISC, BIOCSETIF = 0x40044266, 0x20004269, 0x8020426C
BIOCIMMEDIATE, BIOCSHDRCMPLT, BIOCSSEESENT = 0x80044270, 0x80044275, 0x80044277


def ifconfig(*args, check=True):
    return subprocess.run(['ifconfig', *args], capture_output=True, check=check).returncode == 0


def make_pair():
    if not ifconfig(PEER, check=False):
        ifconfig(PEER, 'create')
        ifconfig(IF, 'create')
        ifconfig(PEER, 'peer', IF)
    ifconfig(PEER, 'up')
    ifconfig(IF, 'up')


def open_bpf():
    for n in range(256):
        try:
            fd = os.open(f'/dev/bpf{n}', os.O_RDWR)
            break
        except OSError:
            continue
    else:
        sys.exit('no free /dev/bpf device')
    u = lambda v: struct.pack('I', v)
    fcntl.ioctl(fd, BIOCSETIF, struct.pack('16s16x', IF.encode()))
    fcntl.ioctl(fd, BIOCIMMEDIATE, u(1))
    fcntl.ioctl(fd, BIOCSHDRCMPLT, u(1))  # keep melonDS's source MAC on what we write
    fcntl.ioctl(fd, BIOCSSEESENT, u(0))  # don't read back our own writes
    fcntl.ioctl(fd, BIOCPROMISC)
    return fd, struct.unpack('I', fcntl.ioctl(fd, BIOCGBLEN, u(0)))[0]


def frames(buf):
    """The frames in one BPF read: bpf_hdr {timeval32, caplen u32 @8, datalen u32, hdrlen u16 @16}, 4-byte aligned."""
    i = 0
    while i + 18 <= len(buf):
        caplen, = struct.unpack_from('I', buf, i + 8)
        hdrlen, = struct.unpack_from('H', buf, i + 16)
        yield buf[i + hdrlen:i + hdrlen + caplen]
        i += (hdrlen + caplen + 3) & ~3


def to_stdout(fd, blen):
    out = sys.stdout.buffer
    while True:
        for f in frames(os.read(fd, blen)):
            out.write(struct.pack('>H', len(f)) + f)
        out.flush()


def main():
    make_pair()
    fd, blen = open_bpf()
    threading.Thread(target=to_stdout, args=(fd, blen), daemon=True).start()
    print(f'{PEER} ready for melonDS Direct mode', file=sys.stderr, flush=True)
    inp = sys.stdin.buffer
    while (head := inp.read(2)) and len(head) == 2:
        os.write(fd, inp.read(struct.unpack('>H', head)[0]))


if __name__ == '__main__':
    if sys.argv[1:] == ['--self-check']:
        hdr = lambda n: struct.pack('IIIIH', 0, 0, n, n, 18)
        buf = hdr(15) + b'a' * 15 + b'\0' * 3 + hdr(14) + b'b' * 14  # 18 + 15 rounds up to 36
        assert list(frames(buf)) == [b'a' * 15, b'b' * 14]
        print('ok')
    else:
        main()
