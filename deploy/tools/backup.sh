#!/usr/bin/env bash
# Бэкап данных ReqCheck в /backups/<UTC-время>/ (на хосте — ./backups):
#   postgres.dump      — pg_dump в custom-формате (восстанавливается pg_restore)
#   qdrant/*.snapshot  — снапшот каждой коллекции Qdrant
#   s3/                — копия бакета ${S3_BUCKET} (исходные файлы и выгрузки отчётов)
#   manifest.json      — что и когда сохранено
# Redis не бэкапится: там очередь задач, прогресс и кеш — всё восстановимо.
# Запуск: docker compose --profile backup run --rm backup
set -euo pipefail

ts=$(date -u +%Y%m%dT%H%M%SZ)
dir="/backups/$ts"
tmp="/backups/.tmp-$ts"
mkdir -p "$tmp/qdrant" "$tmp/s3"
trap 'rm -rf "$tmp"' EXIT

log() { printf '[backup %s] %s\n' "$(date -u +%T)" "$*"; }

log "PostgreSQL → postgres.dump"
pg_dump -Fc --no-owner --no-acl -f "$tmp/postgres.dump"

log "Qdrant → qdrant/*.snapshot"
H=(-H "api-key: $QDRANT_API_KEY")
collections=$(curl -sf "${H[@]}" "$QDRANT_URL/collections" | jq -r '.result.collections[].name')
for c in $collections; do
  name=$(curl -sf "${H[@]}" -X POST "$QDRANT_URL/collections/$c/snapshots?wait=true" | jq -r '.result.name')
  curl -sf "${H[@]}" -o "$tmp/qdrant/$c.snapshot" "$QDRANT_URL/collections/$c/snapshots/$name"
  curl -sf "${H[@]}" -X DELETE "$QDRANT_URL/collections/$c/snapshots/$name?wait=true" >/dev/null || true
  log "  $c ($(du -h "$tmp/qdrant/$c.snapshot" | cut -f1))"
done

log "S3 s3://$S3_BUCKET → s3/"
rclone copy "s3:$S3_BUCKET" "$tmp/s3" --transfers 8 --checkers 16
s3_count=$(find "$tmp/s3" -type f | wc -l)

jq -n --arg ts "$ts" --arg db "$PGDATABASE" --arg bucket "$S3_BUCKET" \
  --argjson s3_objects "$s3_count" --arg collections "$collections" \
  --arg pg_server "$(psql -XAtq -c 'show server_version')" '{
    created_at: $ts, postgres: {database: $db, server_version: $pg_server, file: "postgres.dump"},
    qdrant: {collections: ($collections | split("\n") | map(select(length > 0)))},
    s3: {bucket: $bucket, objects: $s3_objects}
  }' > "$tmp/manifest.json"

mv "$tmp" "$dir"
trap - EXIT
log "готово: $dir ($(du -sh "$dir" | cut -f1))"

keep="${BACKUP_KEEP_DAYS:-14}"
if [[ "$keep" =~ ^[0-9]+$ ]] && (( keep > 0 )); then
  find /backups -mindepth 1 -maxdepth 1 -type d -regex '.*/[0-9]\{8\}T[0-9]\{6\}Z' -mtime "+$keep" -print -exec rm -rf {} + \
    | sed 's/^/[backup] удалён старый бэкап: /'
fi
