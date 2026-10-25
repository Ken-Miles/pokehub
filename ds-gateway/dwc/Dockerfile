# FR-39: sign-in (nas) and the GameSpy services for DS games, from dwc_network_server_emulator
# (AltWFC, AGPL-3.0), unmodified and pinned. It's Python 2 + Twisted. Runs inside the DS
# gateway's network (docker-compose.yml), so the services sit on the DS bridge at 10.77.0.1;
# its HTTP services listen on 127.0.0.1 behind ds-web (nginx.conf).
# AGPL: if we change this code, the changed source must be offered to its users.
FROM python:2.7
RUN pip install --no-cache-dir twisted==20.3.0
ARG DWC_COMMIT=2c65a9f6afe508e236c222bd1b8f26fd63621a91
RUN git clone --quiet https://github.com/barronwaffles/dwc_network_server_emulator.git /dwc \
 && git -C /dwc checkout --quiet "${DWC_COMMIT}" \
 && mkdir /dwc/data && ln -s data/gpcm.db /dwc/gpcm.db
# Our one change: the admin, register and internal stats pages bind every interface,
# which would put them on the DS bridge. Keep them on localhost.
RUN cd /dwc && sed -i "s/reactor.listenTCP(\(.*\))$/reactor.listenTCP(\1, interface='127.0.0.1')/" \
      admin_page_server.py register_page.py internal_stats_server.py \
 && ! grep -n "listenTCP(" admin_page_server.py register_page.py internal_stats_server.py | grep -v "interface='127.0.0.1'"
WORKDIR /dwc
CMD ["python", "-u", "master_server.py"]
