# Link latency spike

Measures what each way of linking Gen 3 games would feel like, before any
emulator exists. Findings and the method are in the vault note
*Link latency experiments*; raw results are in `results/`.

```bash
npm run spike:link                                    # bench server on :3100 (all interfaces)
```

- **One machine:** open `http://localhost:3100/?mode=loopback&auto=1` (keep the tab in front).
- **Two devices on one network:** on the second device open
  `http://<this-machine-ip>:3100/?mode=pair&room=test&role=1&transports=relay,webrtc`,
  then on this machine `…&role=0&auto=1&label=my-wifi` with the same room and transports.
- **Hosting load:** with the server running, `npm run spike:link:load -- lockstep 10,100,200`
  (or `naive 10,50`). Results are saved to `results/`.

Not part of the app; nothing here touches game files.
