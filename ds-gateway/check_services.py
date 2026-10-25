"""FR-39 check: the Nintendo services answer on the DS bridge address, as a DS would call them.

    docker compose --profile ds exec -T ds-gateway python3 - < ds-gateway/check_services.py
"""
import base64
import socket
import urllib.parse
import urllib.request

BRIDGE = '10.77.0.1'


def b64(s):
    return base64.b64encode(s.encode()).decode().replace('=', '*')  # the DS's base64 flavour


def nas(fields):
    body = urllib.parse.urlencode({k: b64(v) for k, v in fields.items()}).encode()
    req = urllib.request.Request(f'http://{BRIDGE}/ac', body, {'Host': 'nas.nintendowifi.net'})
    raw = urllib.request.urlopen(req, timeout=5).read().decode()
    return {k: base64.b64decode(v.replace('*', '=')).decode() for k, v in urllib.parse.parse_qsl(raw)}


r = urllib.request.urlopen(urllib.request.Request(f'http://{BRIDGE}/', headers={'Host': 'conntest.nintendowifi.net'}), timeout=5)
assert r.status == 200 and r.headers['X-Organization'] == 'Nintendo', 'conntest'

ds = {'gsbrcd': 'IRBJ', 'sdkver': '005001', 'userid': '1234567890123', 'passwd': '123', 'gamecd': 'IRBO',
      'makercd': '01', 'unitcd': '0', 'macadr': '02000000aa01', 'lang': '01', 'devname': 'check', 'ingamesn': 'check'}
# Sign-in only works from a tunnelled DS (spikes/ds-wifi/signin-check.mts covers that); from here it's refused.
assert nas(dict(ds, action='acctcreate'))['returncd'] == '3914', 'sign-in without a tunnel must be refused'

# GameSpy login (gpcm) greets every new connection with a challenge.
with socket.create_connection((BRIDGE, 29900), timeout=5) as s:
    assert s.recv(256).startswith(b'\\lc\\1\\challenge\\'), 'gpcm'
for port in (29901, 29920, 28910):
    socket.create_connection((BRIDGE, port), timeout=5).close()

# Admin and register pages must not be on the bridge.
for port in (9001, 9009, 9998):
    try:
        socket.create_connection((BRIDGE, port), timeout=2).close()
        raise AssertionError(f'port {port} is reachable from the bridge')
    except ConnectionRefusedError:
        pass
print('services ok: conntest, nas refuses untunnelled sign-in, gpcm, gpsp, gstats, server browser; admin pages off the bridge')
