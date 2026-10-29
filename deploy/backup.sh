#!/usr/bin/env bash
# Nightly Postgres dump (NFR-10). Run from a user timer or cron on macserver. Keeps 14 days.
# Save blobs live in the s3 volume: copy that off the box too (deploy/README.md).
set -euo pipefail
DEST="$HOME/websites/pokehub/backups"
mkdir -p "$DEST"
out="$DEST/pokehub-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker exec pokehub-postgres pg_dump -U pokehub -Fc pokehub > "$out"
find "$DEST" -name 'pokehub-*.dump' -mtime +14 -delete
echo "backup: $out"
