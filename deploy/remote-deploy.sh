#!/usr/bin/env bash
# Runs ON macserver. Piped in by deploy/deploy.sh; never needs to live there permanently.
#
#   remote-deploy.sh <sha>               build <sha> into the idle colour, migrate, health-check, flip
#   remote-deploy.sh --rollback          flip back to the commit deployed before the live one
#   remote-deploy.sh --services <sha>    (re)start the backing services from <sha>
#
# The live colour keeps serving throughout. Only the idle colour is rebuilt and restarted.
set -euo pipefail

BASE="$HOME/websites/pokehub"
REPO="$BASE/repo.git"             # bare repo the Mac pushes to
SHARED="$BASE/shared"
STATE="$SHARED/active"            # blue | red: the colour nginx sends traffic to
LOG="$SHARED/deploys.log"         # "<utc time> <colour> <sha>" per deploy: the history rollback reads
DRAIN_TIMEOUT="${DRAIN_TIMEOUT:-1800}"  # seconds to wait for a colour's live links before restarting it

die() { echo "!! $*" >&2; exit 1; }
port_of() { case "$1" in blue) echo 4000 ;; red) echo 4001 ;; *) die "unknown colour '$1'" ;; esac; }
health() { curl -sS --max-time 4 "http://127.0.0.1:$(port_of "$1")/api/health" 2>/dev/null || true; }
# Reads one field of the JSON on stdin ("" when missing or not JSON).
field() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s)[process.argv[1]];console.log(v==null?"":v)}catch{console.log("")}})' "$1"
}

mkdir -p "$SHARED" "$BASE/releases"
exec 9>"$SHARED/deploy.lock"
flock -n 9 || die "another deploy is running"

# ---- services: Postgres, Redis, storage, save service (compose; see deploy/README.md)
if [ "${1:-}" = "--services" ]; then
  SHA="${2:?usage: --services <sha>}"
  [[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "not a full commit sha: $SHA"
  DIR="$BASE/services"
  [ -d "$DIR/.git" ] || git clone --quiet "$REPO" "$DIR"
  git -C "$DIR" fetch --quiet origin
  git -C "$DIR" reset --hard --quiet "$SHA"
  echo "==> compose up at $SHA"
  docker compose -p pokehub -f "$DIR/deploy/compose.yml" --env-file "$SHARED/.env" up -d --build
  exit 0
fi

[ -f "$STATE" ] || die "no $STATE: bootstrap first (deploy/README.md)"
LIVE="$(cat "$STATE")"
port_of "$LIVE" >/dev/null
if [ "$LIVE" = blue ]; then TARGET=red; else TARGET=blue; fi
TPORT="$(port_of "$TARGET")"
DIR="$BASE/releases/$TARGET"

if [ "${1:-}" = "--rollback" ]; then
  [ -f "$LOG" ] || die "no deploy history to roll back to"
  CUR="$(tail -n 1 "$LOG" | cut -d' ' -f3)"
  SHA="$(awk -v cur="$CUR" '$3 != cur { prev = $3 } END { print prev }' "$LOG")"
  [ -n "$SHA" ] || die "no earlier deploy to roll back to"
  echo "==> rolling back to $SHA"
else
  SHA="${1:?usage: remote-deploy.sh <sha> | --rollback | --services <sha>}"
fi
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "not a full commit sha: $SHA"
git -C "$REPO" cat-file -e "$SHA^{commit}" 2>/dev/null || die "$SHA is not in $REPO (push it first)"

# Expand/contract (docs/design.md, deploy/README.md): the live colour still runs
# against this database, so a migration may only add things until the next deploy.
guard_migrations() {
  local live_sha diff
  live_sha="$(health "$LIVE" | field version)"
  if [ -z "$live_sha" ] || [ "$live_sha" = dev ] || ! git -C "$DIR" cat-file -e "$live_sha^{commit}" 2>/dev/null; then
    echo "   (no live version to compare migrations with: check skipped)"
    return
  fi
  diff="$(git -C "$DIR" diff "$live_sha" "$SHA" -- prisma/migrations)"
  if grep -qE '^[+-].*(DROP |RENAME |ALTER COLUMN)' <<<"$diff"; then
    [ "${ALLOW_BREAKING_MIGRATION:-}" = 1 ] || die "migrations since $live_sha drop, rename or alter columns; split them (expand/contract) or set ALLOW_BREAKING_MIGRATION=1"
    echo "!! ALLOW_BREAKING_MIGRATION=1: continuing with a breaking migration"
  fi
}

wait_drained() {
  local deadline=$(( $(date +%s) + DRAIN_TIMEOUT )) n
  while :; do
    n="$(health "$1" | field activeLinks)"
    if [ -z "$n" ] || [ "$n" = 0 ]; then return 0; fi
    [ "$(date +%s)" -lt "$deadline" ] || die "$1 still has $n live link session(s) after ${DRAIN_TIMEOUT}s; not restarting it"
    echo "    waiting for $n live link session(s) on $1 to finish"
    sleep 15
  done
}

wait_healthy() {
  for _ in $(seq 1 60); do
    if [ "$(health "$1" | field version)" = "$2" ] && [ "$(health "$1" | field ok)" = true ]; then return 0; fi
    sleep 2
  done
  die "$1 is not healthy on $2; $LIVE is still live and untouched"
}

build_and_start() {
  echo "==> building $SHA into $TARGET (:$TPORT)"
  [ -d "$DIR/.git" ] || git clone --quiet "$REPO" "$DIR"
  git -C "$DIR" fetch --quiet origin
  git -C "$DIR" reset --hard --quiet "$SHA"
  git -C "$DIR" clean -fdq          # ignored files (node_modules, .next, .env) survive
  ln -sfn "$SHARED/.env" "$DIR/.env"
  guard_migrations
  (
    cd "$DIR"
    npm ci --no-audit --no-fund
    npx prisma generate
    npx prisma migrate deploy
    npm run build
  )
  printf 'DEPLOY_COLOR=%s\nDEPLOY_VERSION=%s\n' "$TARGET" "$SHA" > "$SHARED/color-$TARGET.env"
  wait_drained "$TARGET"
  systemctl --user restart "pokehub-$TARGET.service"
  wait_healthy "$TARGET" "$SHA"
}

# A warm standby already running this commit needs no rebuild (the rollback case).
if [ "$(health "$TARGET" | field version)" = "$SHA" ] && [ "$(health "$TARGET" | field ok)" = true ]; then
  echo "==> $TARGET already runs $SHA healthy; no rebuild"
else
  build_and_start
fi

echo "==> flipping nginx to $TARGET (:$TPORT)"
sudo /usr/local/sbin/pokehub-flip "$TPORT"
echo "$TARGET" > "$STATE"
ln -sfn "releases/$TARGET" "$BASE/current"
systemctl --user restart pokehub-worker.service
echo "$(date -u +%FT%TZ) $TARGET $SHA" >> "$LOG"

echo "==> $TARGET is live on :$TPORT at $SHA"
echo "==> $LIVE stays running as the warm standby (rollback target); live links there: $(health "$LIVE" | field activeLinks)"
