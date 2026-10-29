"""FR-38 DS gateway: puts every emulated DS on one virtual network with our servers.

Each browser opens one WebSocket (?t=<ticket from /api/ds/tunnel>) and sends and receives
the DS's Ethernet frames as binary messages. Each tunnel becomes a tap device on bridge
br0 (10.77.0.0/16), so Linux does ARP, IP and switching between DSes, dnsmasq answers
DHCP and points Nintendo's names at us, and nothing is routed off the bridge
(ip_forward=0). Only frames from the ticket's MAC, and from the IP dnsmasq leased to it,
are forwarded. The Nintendo services (ds-services, ds-web in docker-compose.yml) share
this container's network.

FR-39: sign-in requests (nas /ac) come through here first (ds-web sends them to
127.0.0.1:8791). The DS's IP gives its tunnel, so its site account; the site
(/api/ds/signin) says whether that account may make the request, and hands out the WFC
user ID for new accounts, so later sign-ins must use it.
"""
import asyncio
import base64
import fcntl
import hashlib
import hmac
import itertools
import json
import os
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, parse_qsl, urlparse

BRIDGE, WS_PORT = 'br0', 8790
TUNSETIFF, IFF_TAP, IFF_NO_PI = 0x400454CA, 0x0002, 0x1000
MAX_FRAME = 1600
RATE, BURST = 256 * 1024, 1024 * 1024  # bytes/s per tunnel, NFR-05
LEASES = '/var/lib/misc/dnsmasq.leases'
SIGNIN_PORT, NAS = 8791, 'http://127.0.0.1:9000'


def log(event, **fields):
    print(json.dumps({'t': round(time.time(), 3), 'event': event, **fields}), flush=True)


def verify(ticket, secret, now=None):
    """The ticket's claims {u, m, e} if lib/ds-tunnel.ts signed it and it hasn't expired."""
    try:
        body, sig = ticket.split('.')
        want = base64.urlsafe_b64encode(hmac.new(secret, body.encode(), hashlib.sha256).digest()).rstrip(b'=').decode()
        if not hmac.compare_digest(sig, want):
            return None
        claims = json.loads(base64.urlsafe_b64decode(body + '=' * (-len(body) % 4)))
        return claims if claims['e'] >= (now if now is not None else time.time()) else None
    except (ValueError, KeyError, TypeError):
        return None


def open_tap(name):
    fd = os.open('/dev/net/tun', os.O_RDWR | os.O_NONBLOCK)
    fcntl.ioctl(fd, TUNSETIFF, struct.pack('16sH', name.encode(), IFF_TAP | IFF_NO_PI))
    subprocess.run(['ip', 'link', 'set', name, 'master', BRIDGE, 'up'], check=True)
    return fd  # closing it deletes the tap


_leases, _leases_read = {}, 0.0


def read_leases():
    global _leases, _leases_read
    _leases_read = time.monotonic()
    try:
        with open(LEASES) as f:  # expiry mac ip host client-id
            _leases = {p[1]: socket.inet_aton(p[2]) for p in (line.split() for line in f) if len(p) >= 3}
    except OSError:
        pass


def lease_ip(mac_text, fresh=False):
    """The IPv4 address (4 bytes) dnsmasq leased to this MAC, or None. Frames re-read at most once a second."""
    if (fresh or mac_text not in _leases) and time.monotonic() - _leases_read > 1:
        read_leases()
    return _leases.get(mac_text)


def l3_allowed(frame, ip):
    """IPv4 and ARP only, from the DS's leased IP (or 0.0.0.0 while it asks DHCP for one)."""
    if frame[12:14] == b'\x08\x00':
        src = frame[26:30]
    elif frame[12:14] == b'\x08\x06' and len(frame) >= 42:
        src = frame[28:32]
    else:
        return False
    return src == b'\0\0\0\0' or src == ip


tunnels = {}  # user id -> websocket
macs = {}  # mac -> user id
tap_names = itertools.count()


async def handler(ws):
    from websockets.exceptions import ConnectionClosed

    claims = verify(parse_qs(urlparse(ws.request.path).query).get('t', [''])[0], SECRET)
    if not claims:
        log('refused', reason='ticket')
        return await ws.close(4001, 'bad ticket')
    user, mac_text = claims['u'], claims['m']
    if macs.get(mac_text, user) != user:
        log('refused', reason='mac-in-use', user=user, mac=mac_text)
        return await ws.close(4003, 'mac in use')
    if user in tunnels:  # one DS per account: the newest tunnel wins
        await tunnels[user].close(4002, 'replaced')
    tunnels[user], macs[mac_text] = ws, user
    mac = bytes.fromhex(mac_text.replace(':', ''))
    name = f'ds{next(tap_names) % 1_000_000}'
    fd = open_tap(name)
    loop = asyncio.get_running_loop()
    out = asyncio.Queue(maxsize=256)

    def from_tap():
        try:
            out.put_nowait(os.read(fd, 2048))
        except (BlockingIOError, asyncio.QueueFull):
            pass  # a browser that can't keep up loses frames, like a real network

    async def to_browser():
        while True:
            await ws.send(await out.get())

    loop.add_reader(fd, from_tap)
    sender = asyncio.create_task(to_browser())
    log('open', user=user, mac=mac_text, tap=name)
    allowance, last = BURST, time.monotonic()
    counts = {'in': 0, 'shape': 0, 'mac': 0, 'l3': 0, 'rate': 0}

    def drop(reason, frame):
        counts[reason] += 1
        if counts[reason] == 1:  # the first of each kind says what's wrong without flooding the log
            log('drop', user=user, tap=name, reason=reason, head=frame[:34].hex() if isinstance(frame, bytes) else type(frame).__name__)

    try:
        async for frame in ws:
            counts['in'] += 1
            if not isinstance(frame, bytes) or not 14 <= len(frame) <= MAX_FRAME:
                drop('shape', frame)
                continue
            if frame[6:12] != mac:
                drop('mac', frame)
                continue
            if not l3_allowed(frame, lease_ip(mac_text)) and not l3_allowed(frame, lease_ip(mac_text, fresh=True)):
                drop('l3', frame)
                continue
            now = time.monotonic()
            allowance, last = min(BURST, allowance + (now - last) * RATE), now
            if allowance < len(frame):
                drop('rate', frame)
                continue
            allowance -= len(frame)
            try:
                os.write(fd, frame)
            except OSError:
                pass
    except ConnectionClosed:
        pass
    finally:
        sender.cancel()
        loop.remove_reader(fd)
        os.close(fd)
        if tunnels.get(user) is ws:
            del tunnels[user], macs[mac_text]
        log('close', user=user, tap=name, frames=counts)


def dwc_decode(v):
    return base64.b64decode(v.replace('*', '=')).decode('latin-1')  # the DS's base64 flavour


def dwc_encode(fields):
    return '&'.join(f"{k}={base64.b64encode(v.encode()).decode().replace('=', '*')}" for k, v in fields.items()).encode()


def site(payload):
    req = urllib.request.Request(f'{SITE_URL}/api/ds/signin', json.dumps(payload).encode(),
                                 {'Content-Type': 'application/json', 'x-ds-gateway-key': SECRET.decode()})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.load(r)


def account_for_ip(ip_text):
    """(user, mac) of the tunnel whose DS holds this IP, or (None, None)."""
    try:
        ip = socket.inet_aton(ip_text)
    except OSError:
        return None, None
    read_leases()  # sign-ins are rare; always use the current leases
    for mac_text, user in list(macs.items()):
        if lease_ip(mac_text) == ip:
            return user, mac_text
    return None, None


class Signin(BaseHTTPRequestHandler):
    """nas /ac in front of dwc: only the account's own DS, with the account's own WFC ID."""

    def do_POST(self):
        body = self.rfile.read(min(int(self.headers.get('Content-Length') or 0), 4096))
        try:
            fields = {k: dwc_decode(v) for k, v in parse_qsl(body.decode('latin-1'))}
        except ValueError:
            fields = {}
        action, wfc_id = fields.get('action', ''), fields.get('userid')
        ip = self.headers.get('X-Forwarded-For', '')
        user, mac_text = account_for_ip(ip)
        reason = None
        if not user:
            reason = 'no-tunnel'
        elif fields.get('macadr', '').lower() != mac_text.replace(':', ''):
            reason = 'mac'
        else:
            try:
                check = site({'user': user, 'action': action, **({'wfcUserId': wfc_id} if wfc_id else {})})
                reason = None if check.get('allow') else check.get('reason', 'refused')
            except OSError as e:  # the site is down: fail closed
                reason = f'site: {e}'
        if reason:
            log('signin-refused', user=user, ip=ip, action=action, wfc=wfc_id, reason=reason)
            return self.reply(200, {'Content-Type': 'text/plain'}, dwc_encode({'retry': '1', 'returncd': '3914', 'locator': 'gamespy.com'}))

        req = urllib.request.Request(NAS + self.path, body, {'Host': self.headers.get('Host', ''), 'X-Forwarded-For': ip,
                                                             'Content-Type': self.headers.get('Content-Type', 'application/x-www-form-urlencoded')})
        with urllib.request.urlopen(req, timeout=10) as r:
            status, headers, answer = r.status, dict(r.headers), r.read()
        out = {k: dwc_decode(v) for k, v in parse_qsl(answer.decode('latin-1'))}
        if action.lower() == 'acctcreate' and out.get('returncd') == '002':
            # The site picks the ID (dwc's repeats) and binds it to the account; the DS stores it.
            try:
                out['userid'] = site({'user': user, 'allocate': True})['wfcUserId']
            except (OSError, KeyError) as e:
                log('signin-refused', user=user, ip=ip, action=action, reason=f'allocate: {e}')
                return self.reply(200, {'Content-Type': 'text/plain'}, dwc_encode({'retry': '1', 'returncd': '3914', 'locator': 'gamespy.com'}))
            answer = dwc_encode(out)
        log('signin', user=user, ip=ip, action=action, wfc=wfc_id or out.get('userid'), returncd=out.get('returncd'))
        self.reply(status, {k: v for k, v in headers.items() if k.lower() not in ('content-length', 'connection', 'transfer-encoding', 'date', 'server')}, answer)

    def reply(self, status, headers, body):
        self.send_response(status)
        for k, v in headers.items():
            self.send_header(k, v)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


async def main():
    from websockets.asyncio.server import serve

    threading.Thread(target=ThreadingHTTPServer(('127.0.0.1', SIGNIN_PORT), Signin).serve_forever, daemon=True).start()
    async with serve(handler, '0.0.0.0', WS_PORT, max_size=MAX_FRAME, compression=None):
        log('listening', port=WS_PORT)
        await asyncio.Future()


def selftest():
    # Same vector as tests/ds-tunnel.test.ts.
    secret = b'test-secret-test-secret-test-secret!'
    ticket = ('eyJ1IjoidXNlcl8xIiwibSI6IjAyOjQyOjY0OjE5OjRjOjRjIiwiZSI6MTcwMDAwMDA2MH0.'
              'F1pI2hKpQ6kSrtix3gDAmOWLMBcoFBX6LsS7aVOT8U8')
    assert verify(ticket, secret, now=1_700_000_000) == {'u': 'user_1', 'm': '02:42:64:19:4c:4c', 'e': 1_700_000_060}
    assert verify(ticket, secret, now=1_700_000_061) is None, 'expired'
    assert verify(ticket, b'x' * 36, now=1_700_000_000) is None, 'wrong secret'
    assert verify(ticket.replace('eyJ1', 'eyJ2'), secret, now=1_700_000_000) is None, 'tampered'
    assert verify('garbage', secret) is None
    eth = lambda etype: b'\xff' * 6 + b'\x02' * 6 + etype
    ipv4 = lambda src: eth(b'\x08\x00') + b'\x45' + b'\0' * 11 + src + b'\xff' * 4
    leased = socket.inet_aton('10.77.1.5')
    assert l3_allowed(ipv4(b'\0\0\0\0'), None), 'DHCP before a lease'
    assert l3_allowed(ipv4(leased), leased)
    assert not l3_allowed(ipv4(socket.inet_aton('10.77.1.6')), leased), 'spoofed source IP'
    assert not l3_allowed(ipv4(leased), None), 'no lease yet'
    arp = lambda sender: eth(b'\x08\x06') + b'\0' * 14 + sender + b'\0' * 10
    assert l3_allowed(arp(leased), leased) and not l3_allowed(arp(socket.inet_aton('10.77.0.1')), leased)
    assert not l3_allowed(eth(b'\x86\xdd') + b'\0' * 40, leased), 'IPv6'
    assert {k: dwc_decode(v) for k, v in parse_qsl(dwc_encode({'userid': '42', 'returncd': '001'}).decode())} == {'userid': '42', 'returncd': '001'}
    print('selftest ok')


if __name__ == '__main__':
    if sys.argv[1:] == ['--selftest']:
        selftest()
    else:
        SECRET = os.environ['DS_GATEWAY_SECRET'].encode()
        assert len(SECRET) >= 32, 'DS_GATEWAY_SECRET must be 32+ characters'
        SITE_URL = os.environ['DS_SITE_URL'].rstrip('/')
        asyncio.run(main())
