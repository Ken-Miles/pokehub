# Deploying Pokémon Hub to macserver

Blue/green on one Linux box (`macserver`, Debian arm64, 8 cores, 15 GB RAM).
Every deploy builds the idle colour, migrates, health-checks it, and only then
moves traffic. The live colour never stops serving.

```
 https://pokehub.aidenpearce.space ─► Cloudflare tunnel ─► nginx 127.0.0.1:80 ─► pokehub_backend ─┬─► blue  :4000 (pokehub-blue.service)
                                                                    └─► red   :4001 (pokehub-red.service)
                                   both colours + worker ─► Postgres :5433, Redis :6379,
                                                            S3 (SeaweedFS) :9000, save service (unix socket)
```

## How versions work

- **A deploy is a commit.** `deploy/deploy.sh` refuses a dirty tree, pushes HEAD to
  GitHub (`origin`, branch `prod`), and macserver clones that repo and builds the exact SHA.
  The repo is public (`https://github.com/Ken-Miles/pokehub`), so macserver needs no credentials.
  Nothing is copied from your working directory.
- **The history is the log.** `~/websites/pokehub/shared/deploys.log` gets one line per
  deploy (`time colour sha`). `./deploy/deploy.sh --status` shows it.
- **Rollback is a flip.** The previous colour stays warm on the previous commit, so
  `--rollback` is one nginx reload (seconds), not a rebuild.
- **Migrations are expand/contract.** The live colour runs against the same database
  while the new one starts. A migration may add tables, columns and indexes. It may not
  drop, rename or alter a column in the same deploy. Split the change over two deploys:
  add the new column and write both, then move reads over, then drop the old one. The
  deploy refuses a breaking migration unless you set `ALLOW_BREAKING_MIGRATION=1`.
  Because of this rule, rolling back the code is always safe.
- **Each process reports its version.** `GET /api/health` returns `color`, `version`
  (the SHA) and `activeLinks`. A deploy checks these before it flips, and before it
  restarts a colour.

## One-time setup (you run the `sudo` lines)

Shorthand: "on macserver" means `ssh macserver`.

1. Let user `j` run Docker and start the stack at boot (on macserver):
   ```bash
   sudo usermod -aG docker j
   ```
   Log out and back in, then:
   ```bash
   sudo systemctl enable --now docker
   ```
   ```bash
   sudo loginctl enable-linger j
   ```
   Linger keeps the user services running when nobody is logged in.

2. Install nginx (on macserver), then remove Debian's default site so port 80 is free for Pokémon Hub:
   ```bash
   sudo apt install -y nginx
   ```
   ```bash
   sudo rm -f /etc/nginx/sites-enabled/default
   ```

3. Install the flip helper and its sudo rule, from the repo on your Mac:
   ```bash
   ssh macserver 'cat > /tmp/pokehub-flip' < deploy/root/pokehub-flip && ssh -t macserver 'sudo install -m 0755 /tmp/pokehub-flip /usr/local/sbin/pokehub-flip'
   ```
   ```bash
   ssh macserver 'cat > /tmp/sudoers-pokehub' < deploy/root/sudoers-pokehub && ssh -t macserver 'sudo install -m 0440 /tmp/sudoers-pokehub /etc/sudoers.d/pokehub && sudo visudo -cf /etc/sudoers.d/pokehub'
   ```

4. Install the nginx site and upstream, then check and reload:
   ```bash
   for f in pokehub.conf pokehub-upstream.conf; do ssh macserver "cat > /tmp/$f" < deploy/nginx/$f; done && ssh -t macserver 'sudo install -m 0644 /tmp/pokehub.conf /tmp/pokehub-upstream.conf /etc/nginx/conf.d/ && sudo nginx -t && sudo systemctl reload nginx'
   ```

5. Install the user units from your Mac (the units are not needed until the first deploy). Files are piped over ssh rather than copied with `scp`:
   ```bash
   ssh macserver 'mkdir -p ~/.config/systemd/user' && for f in deploy/systemd/*.service; do ssh macserver "cat > ~/.config/systemd/user/$(basename $f)" < "$f"; done && ssh macserver 'systemctl --user daemon-reload'
   ```
   Re-run this when a unit file changes in the repo.

6. Create the server layout (on macserver):
   ```bash
   mkdir -p ~/websites/pokehub/{shared,releases,run,backups} && echo blue > ~/websites/pokehub/shared/active
   ```
   Then create `~/websites/pokehub/shared/.env` from `deploy/env.example` and fill in the secrets.
   Keep `TRUSTED_PROXY_HOPS` at 2 until you have checked the client IP (below).

7. Start Postgres, Redis, storage and the save service. Run this from your Mac after you
   commit the deploy kit. It pushes HEAD and starts the compose stack from that commit:
   ```bash
   ./deploy/deploy.sh --services
   ```

8. Public address. macserver's `cloudflared` runs a remote-managed tunnel (`tunnel run --token`),
   so its routes live in the Cloudflare Zero Trust dashboard, not on the box. Add a public
   hostname there:
   - Subdomain `pokehub`, domain `aidenpearce.space`
   - Service `HTTP` → `localhost:80`

   Visitors use `https://pokehub.aidenpearce.space` with no port. Cloudflare provides the
   TLS certificate. If the hostname changes later, change it here, in
   `NEXTAUTH_URL` in `shared/.env`, and in the nginx `server_name`.

9. Deploy (from your Mac, after committing):
   ```bash
   ./deploy/deploy.sh
   ```

10. Check the client IP. Sign in from a browser, then look at the rate-limit key or the
    audit log's IP field. It should be your real IP, not Cloudflare's or nginx's. If it
    shows a proxy address, change `TRUSTED_PROXY_HOPS` in `shared/.env` (1 or 2) and
    restart the colour that is live.

11. Backups. Schedule the nightly dump (on macserver), with the user timer you prefer:
    ```bash
    crontab -l 2>/dev/null | { cat; echo '30 3 * * * $HOME/websites/pokehub/current/deploy/backup.sh >> $HOME/websites/pokehub/backups/backup.log 2>&1'; } | crontab -
    ```
    NFR-10 also wants the save blobs (the `s3data` volume) copied off the box. That is not
    done yet.

## Daily use

| Task | Command (from your Mac, repo root) |
| --- | --- |
| Deploy the committed HEAD | `./deploy/deploy.sh` |
| Go back one deploy | `./deploy/deploy.sh --rollback` |
| What is live, recent deploys | `./deploy/deploy.sh --status` |
| Redeploy the backing services (Postgres, Redis, save service, …) | `./deploy/deploy.sh --services` |

A deploy that fails its health check leaves the live colour serving. Read the output
(it names the step) and fix the cause, then deploy again.

## What uptime this gives you, and what it doesn't

Covered: code deploys, config changes (a restart of the idle colour), migrations that
follow the rule above, and failed builds or failed health checks.

Not covered, and worth knowing:

- **One machine.** A power cut, a kernel panic, a bad disk, or an internet outage at
  your site stops everything. Real 100% needs a second host. The layout here (colour
  names, the flip, the compose file) carries over to one.
- **One Postgres, one Redis.** No replica and no failover. The nightly dump is the only
  copy of the database. Keep the backups off the box.
- **Link sessions live in one process.** A link session's relay state is held in the
  colour that first relays it. When you deploy, that colour keeps running (warm) until its
  sessions end. Nothing new is routed to it, and a deploy waits for its sessions before it
  restarts that colour (up to `DRAIN_TIMEOUT`, 30 min). A player who loses their connection
  during a deploy reconnects to the new colour and loses that session. The new colour
  ends sessions only when it starts, and only ones it owns (`relayOwner`).
- **The save service is shared and not blue/green.** Restarting it (`--services`)
  causes a few seconds where uploads fail. Uploads are retried by the browser.

## Files

| File | Where it goes on macserver |
| --- | --- |
| `deploy.sh` (Mac) | runs on your Mac |
| `remote-deploy.sh` | piped to macserver for each deploy; never copied there permanently |
| `systemd/pokehub-{blue,red,worker}.service` | `~/.config/systemd/user/` |
| `nginx/pokehub.conf`, `nginx/pokehub-upstream.conf` | `/etc/nginx/conf.d/` |
| `root/pokehub-flip` | `/usr/local/sbin/pokehub-flip` |
| `root/sudoers-pokehub` | `/etc/sudoers.d/pokehub` |
| `compose.yml` | run by `--services` from the pinned commit |
| `env.example` | `~/websites/pokehub/shared/.env` (filled in, never committed) |
| `backup.sh` | nightly, from cron |
