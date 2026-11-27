#!/usr/bin/env bash
# Диспетчер служебных команд: smoke | backup | restore <каталог-бэкапа> | list
set -euo pipefail

# rclone настраивается только переменными окружения — конфиг-файл не нужен.
export RCLONE_CONFIG_S3_TYPE=s3
export RCLONE_CONFIG_S3_PROVIDER=SeaweedFS
export RCLONE_CONFIG_S3_ENDPOINT="${S3_ENDPOINT_URL:-http://seaweedfs:8333}"
export RCLONE_CONFIG_S3_ACCESS_KEY_ID="${S3_ACCESS_KEY:-}"
export RCLONE_CONFIG_S3_SECRET_ACCESS_KEY="${S3_SECRET_KEY:-}"
export RCLONE_CONFIG_S3_FORCE_PATH_STYLE=true
export RCLONE_CONFIG_S3_NO_CHECK_BUCKET=true

cmd="${1:-smoke}"
shift || true
case "$cmd" in
  smoke)   exec /opt/reqcheck/smoke.sh "$@" ;;
  backup)  exec /opt/reqcheck/backup.sh "$@" ;;
  restore) exec /opt/reqcheck/restore.sh "$@" ;;
  list)    ls -1 /backups | grep -E '^[0-9]{8}T[0-9]{6}Z$' || echo "бэкапов нет" ;;
  *)       exec "$cmd" "$@" ;;
esac
