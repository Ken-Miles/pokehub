#!/bin/sh
# FR-38: the bridge every DS tunnel joins, then DHCP/DNS, then the gateway.
set -eu
[ "$(cat /proc/sys/net/ipv4/ip_forward)" = 0 ] || { echo "ip_forward must be 0: DS traffic must not leave the bridge" >&2; exit 1; }
ip link add br0 type bridge
ip addr add 10.77.0.1/16 dev br0
ip link set br0 up
dnsmasq --conf-file=/gateway/dnsmasq.conf
exec python3 /gateway/gateway.py
