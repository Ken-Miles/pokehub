#!/usr/bin/env bash
# Run on your Mac from the repo root. Deploys come from commits, never from a dirty tree.
#
#   ./deploy/deploy.sh              push HEAD to GitHub (prod) and deploy it on macserver (blue/green)
#   ./deploy/deploy.sh --rollback   flip back to the commit deployed before the live one
#   ./deploy/deploy.sh --services   push HEAD and (re)start Postgres, Redis, storage, save service
#   ./deploy/deploy.sh --status     what is live, and the recent deploys
set -euo pipefail

HOST="${POKEHUB_HOST:-macserver}"
BASE='websites/pokehub'                  # relative to the server user's home
# macserver clones this repo from GitHub (remote-deploy.sh): the prod branch is what it deploys.
cd "$(dirname "$0")/.."

# The server runs this repo's copy of remote-deploy.sh, piped in over ssh, so the script
# always matches the commit being deployed.
run_remote() {
  ssh "$HOST" "mkdir -p $BASE/bin && cat > $BASE/bin/remote-deploy.sh && bash $BASE/bin/remote-deploy.sh $1" < deploy/remote-deploy.sh
}

push_head() {
  [ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "commit your changes first: deploys come from commits"; exit 1; }
  SHA="$(git rev-parse HEAD)"
  echo "==> pushing $SHA to origin/prod"
  git push --force-with-lease origin "$SHA:refs/heads/prod"
}

case "${1:-}" in
  "")
    push_head
    echo "==> deploying $SHA"
    run_remote "$SHA"
    ;;
  --rollback) run_remote --rollback ;;
  --services)
    push_head
    echo "==> starting backing services at $SHA"
    run_remote "--services $SHA"
    ;;
  --status) ssh "$HOST" "echo \"live: \$(cat $BASE/shared/active 2>/dev/null || echo none)\"; tail -n 10 $BASE/shared/deploys.log 2>/dev/null || true" ;;
  *) echo "usage: deploy/deploy.sh [--rollback | --services | --status]"; exit 2 ;;
esac
