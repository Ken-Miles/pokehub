# FR-38 DS gateway (see gateway.py). Needs NET_ADMIN and /dev/net/tun; docker-compose.yml.
FROM python:3.13-slim
RUN apt-get update && apt-get install -y --no-install-recommends dnsmasq iproute2 \
 && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir websockets==15.0.1
COPY gateway.py dnsmasq.conf entrypoint.sh /gateway/
RUN python3 /gateway/gateway.py --selftest
ENTRYPOINT ["sh", "/gateway/entrypoint.sh"]
