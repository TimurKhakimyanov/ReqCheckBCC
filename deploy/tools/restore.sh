#!/usr/bin/env bash
# Восстановление из бэкапа. ПЕРЕЗАПИСЫВАЕТ текущие данные Postgres, коллекции Qdrant и бакет S3.
# Перед запуском остановите приложение: docker compose stop web api worker
# Запуск: docker compose --profile backup run --rm backup restore <ИМЯ_БЭКАПА> --yes
set -euo pipefail

name="${1:-}"
confirm="${2:-}"
if [[ -z "$name" ]]; then
  echo "Укажите бэкап: restore <ИМЯ> --yes. Доступные:" >&2
  ls -1 /backups | grep -E '^[0-9]{8}T[0-9]{6}Z$' >&2 || echo "  (нет)" >&2
  exit 2
fi
dir="/backups/$name"
[[ -f "$dir/manifest.json" ]] || { echo "Нет $dir/manifest.json — это не каталог бэкапа" >&2; exit 2; }
if [[ "$confirm" != "--yes" ]]; then
  echo "Восстановление перезапишет текущие данные. Повторите с флагом --yes." >&2
  jq . "$dir/manifest.json" >&2
  exit 2
fi

log() { printf '[restore %s] %s\n' "$(date -u +%T)" "$*"; }

log "PostgreSQL ← postgres.dump"
pg_restore --clean --if-exists --no-owner --no-acl --single-transaction -d "$PGDATABASE" "$dir/postgres.dump"

log "Qdrant ← qdrant/*.snapshot"
shopt -s nullglob
for f in "$dir"/qdrant/*.snapshot; do
  c=$(basename "$f" .snapshot)
  curl -sf -H "api-key: $QDRANT_API_KEY" -X POST \
    "$QDRANT_URL/collections/$c/snapshots/upload?priority=snapshot&wait=true" \
    -F "snapshot=@$f" >/dev/null
  log "  $c"
done

log "S3 s3://$S3_BUCKET ← s3/ (лишние объекты удаляются)"
rclone sync "$dir/s3" "s3:$S3_BUCKET" --transfers 8 --checkers 16

log "готово. Запустите приложение: docker compose up -d"
